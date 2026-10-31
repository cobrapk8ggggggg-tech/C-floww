// Gemini account protocol from the supplied gemini_complete.py; TLS verification stays enabled.
const axios = require('axios');
const crypto = require('crypto');
const { readLines } = require('./streamLines.service');

const GEMINI_BASE = 'https://gemini.google.com';
const GEMINI_USER_ACCT = 'u/1';
const GEMINI_BL = 'boq_assistant-bard-web-server_20260817.02_p0';
const GEMINI_MODEL_JSPB = (
    '[1,null,null,null,"fbb127bbb056c959",null,null,0,' +
    '[4,5,6,8,4,5,6,8],null,null,1,null,null,1,1,' +
    '"036033AF-386B-4A1C-A8B6-F563586CF2B9"]'
);
const GEMINI_STREAM_URL = `${GEMINI_BASE}/${GEMINI_USER_ACCT}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
const GEMINI_APP_URL = `${GEMINI_BASE}/${GEMINI_USER_ACCT}/app`;

// 🔥 وضع الضيف — نفس قيم البروكسي GEMINI_FALLBACK_URL/BL/MODEL_JSPB
const GEMINI_GUEST_STREAM_URL = `${GEMINI_BASE}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
const GEMINI_GUEST_BL = 'boq_assistant-bard-web-server_20240519.16_p0';
const GEMINI_GUEST_MODEL_JSPB = '[1,null,null,null,"35609594dbe934d8"]';

// 🔥 مفتاح وهمي يمثل جلسة الضيف (يُستخدم من المسارات عندما لا توجد كوكيز إطلاقاً)
const GUEST_TOKEN_SENTINEL = 'dummy-key-for-gemini-guest';

// نفس الكوكيز التي يتتبعها البروكسي للتدوير (PSIDTS تدور بشكل دوري من Google)
const TRACKED_COOKIES = new Set([
    'SIDCC', '__Secure-1PSIDCC', '__Secure-3PSIDCC',
    '__Secure-1PSIDTS', '__Secure-3PSIDTS',
    'COMPASS', '_gcl_au', '_ga_WC57KJ50ZZ', '_ga_BF8Q35BMLM',
    'SID', '__Secure-1PSID', '__Secure-3PSID', 'NID'
]);

class GeminiWebAuthError extends Error {
    constructor(message) {
        super(message || 'Gemini Web auth failed: الكوكيز غير صالحة أو منتهية');
        this.name = 'GeminiWebAuthError';
    }
}

// ---------- Cookie jars (in-memory، تتبّع تدوير الكوكيز مثل البروكسي) ----------
const cookieJars = new Map(); // cookieKey -> { cookies: {}, updatedAt }

function parseCookieString(cookieStr) {
    const result = {};
    String(cookieStr || '').split(';').forEach(part => {
        const p = part.trim();
        const idx = p.indexOf('=');
        if (idx > 0) result[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
    });
    return result;
}

function cookiesToString(cookies) {
    return Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
}

function cookieKeyFor(token) {
    const t = String(token || '');
    return 'gem_' + crypto.createHash('md5').update(t || 'empty').digest('hex').substring(0, 16);
}

function getJar(token) {
    const key = cookieKeyFor(token);
    if (!cookieJars.has(key)) {
        if (cookieJars.size >= 128) cookieJars.delete(cookieJars.keys().next().value);
        cookieJars.set(key, { cookies: parseCookieString(token), updatedAt: Date.now() });
    }
    return cookieJars.get(key);
}

// 🔥 جرة كوكيز الضيف المشتركة (تجمع كوكيز المجهولين مثل NID من الردود وتعيد استخدامها —
// تماماً كما يحتفظ AsyncClient في البروكسي بكوكيز jar الخاصة به بين GET و POST)
function getGuestJar() {
    return getJar(GUEST_TOKEN_SENTINEL);
}

function mergeSetCookies(jar, setCookieHeaders) {
    if (!Array.isArray(setCookieHeaders)) return;
    let updated = [];
    for (const raw of setCookieHeaders) {
        const first = String(raw).split(';')[0];
        const idx = first.indexOf('=');
        if (idx <= 0) continue;
        const name = first.slice(0, idx).trim();
        const value = first.slice(idx + 1).trim();
        if (!TRACKED_COOKIES.has(name)) continue;
        if (jar.cookies[name] !== value) {
            jar.cookies[name] = value;
            updated.push(name);
        }
    }
    if (updated.length) {
        jar.updatedAt = Date.now();
        console.log(`[geminiWeb] cookies updated: ${updated.join(', ')}`);
    }
}

// ---------- Headers ----------
function geminiHeaders(cookiesStr) {
    return {
        'authority': 'gemini.google.com',
        'accept': '*/*',
        'accept-language': 'ar,en-US;q=0.9,en;q=0.8',
        'origin': 'https://gemini.google.com',
        'referer': 'https://gemini.google.com/',
        'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36',
        'x-same-domain': '1',
        'cookie': cookiesStr
    };
}

// 🔥 ترويسات وضع الضيف — نفس ترويسات GEMINI_FALLBACK_HEADERS في البروكسي حرفياً
// (كروم ويندوز + en-US، بلا كوكيز)
function geminiGuestHeaders() {
    return {
        'authority': 'gemini.google.com',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'origin': 'https://gemini.google.com',
        'referer': 'https://gemini.google.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
        'x-same-domain': '1',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
    };
}

// هل يحتوي المفتاح المُدخل على كوكيز Gemini فعلية؟
function looksLikeGeminiCookies(token) {
    const t = String(token || '');
    return t.includes('__Secure-1PSID=') || t.includes('SID=');
}

// ---------- استخراج توكني الجلسة من HTML ----------
function extractSessionTokens(page) {
    let snlm0e = null;
    let fdrfje = null;
    for (const pattern of [/"SNlM0e":"(.*?)"/, /'SNlM0e':'(.*?)'/, /SNlM0e["\s]*:["\s]*"([^"]+)"/]) {
        const m = page.match(pattern);
        if (m) { snlm0e = m[1]; break; }
    }
    for (const pattern of [/"FdrFJe":"([\d-]+)"/, /'FdrFJe':'([\d-]+)'/, /FdrFJe["\s]*:["\s]*"([\d-]+)"/]) {
        const m = page.match(pattern);
        if (m) { fdrfje = m[1]; break; }
    }
    return { snlm0e, fdrfje };
}

// جلب صفحة مع تتبّع التحويلات يدوياً ودمج كوكيز كل قفزة (نفس منطق getTokens القديم)
async function fetchPageFollowingRedirects(startUrl, headers, jar) {
    let url = startUrl;
    let resp = null;
    const baseHeaders = { ...headers };
    delete baseHeaders['content-type'];

    for (let hop = 0; hop < 5; hop++) {
        resp = await axios.get(url, {
            headers: baseHeaders,
            timeout: 30000,
            maxRedirects: 0,
            validateStatus: () => true
        });
        mergeSetCookies(jar, resp.headers?.['set-cookie']);
        if ([301, 302, 303, 307, 308].includes(resp.status)) {
            let location = resp.headers?.location || '';
            if (!location) break;
            if (location.startsWith('/')) location = 'https://gemini.google.com' + location;
            const target = new URL(location, url);
            if (target.protocol !== 'https:' || !(target.hostname === 'google.com' || target.hostname.endsWith('.google.com'))) throw new GeminiWebAuthError('Unexpected session redirect');
            url = target.href;
            continue;
        }
        break;
    }
    return String(resp?.data || '');
}

// ---------- جلب توكني الجلسة SNlM0e + FdrFJe (المسار المصادق بالكوكيز) ----------
async function getTokens(jar, options = {}) {
    const page = await fetchPageFollowingRedirects(`${GEMINI_BASE}/u/${options.accountIndex ?? 1}/app`, geminiHeaders(cookiesToString(jar.cookies)), jar);
    const { snlm0e, fdrfje } = extractSessionTokens(page);
    if (!snlm0e) {
        console.error(`[geminiWeb] SNlM0e not found (page len ${page.length}) — الكوكيز غير صالحة أو منتهية`);
        return null;
    }
    // Do not log session tokens.
    return { snlm0e, fdrfje, buildLabel: page.match(/"cfb2h"\s*:\s*"([^"]+)"/)?.[1] };
}

// ---------- 🔥 جلب توكني الجلسة في وضع الضيف (نقل حرفي لـ _gemini_fallback_get_tokens) ----------
// نطلب gemini.google.com مباشرة بدون كوكيز المستخدم ونستخرج SNlM0e + FdrFJe من الرد،
// والجرة تحتفظ بكوكيز المجهولين (NID...) لإعادة استخدامها في POST.
async function getGuestTokens(jar) {
    try {
        const page = await fetchPageFollowingRedirects(GEMINI_BASE, geminiGuestHeaders(), jar);
        const { snlm0e, fdrfje } = extractSessionTokens(page);
        if (!snlm0e) {
            console.error(`[geminiWeb] guest: SNlM0e not found in anonymous response (page len ${page.length})`);
            return null;
        }
        // Do not log session tokens.
        return { snlm0e, fdrfje };
    } catch (e) {
        console.error(`[geminiWeb] guest: token fetch failed: ${e.message}`);
        return null;
    }
}

// ---------- إرسال رسالة (نداء StreamGenerate نفسه في البروكسي — المسار المصادق) ----------
function buildContext(conv) {
    if (!conv) return ['', '', '', null, null, null, null, null, null, ''];
    return [
        conv.conversation_id || '',
        conv.response_id || '',
        conv.choice_id || '',
        null, null, null, null, null, null,
        conv.at_token || ''
    ];
}

// استهلاك رد StreamGenerate التدريجي (مشترك بين المسارين — نفس منطق البروكسي:
// لقطات تدريجية تنمو؛ نقبل ما يمتد النص السابق، وأطول لقطة احتياطاً)
async function consumeStreamGenerate(response, conv) {
    let text = '';
    const newConv = { ...(conv || {}) };
    await readLines(response.data, line => {
        const raw = line.trim();
        if (!raw.startsWith('[')) return; // XSSI prefix and length-prefixed envelopes
        let frames;
        try { frames = JSON.parse(raw); } catch (_) { throw new Error('Malformed Gemini stream frame'); }
        if (!Array.isArray(frames)) return;
        for (const frame of frames) {
            if (!Array.isArray(frame)) continue;
            if (frame[0] === 'er') throw new Error('Gemini stream reported an error');
            if (typeof frame[2] !== 'string') continue;
            let payload;
            try { payload = JSON.parse(frame[2]); } catch (_) { continue; }
            if (payload?.[1]?.[0]) newConv.conversation_id = payload[1][0];
            if (payload?.[1]?.[1]) newConv.response_id = payload[1][1];
            const choice = payload?.[4]?.[0];
            if (choice?.[0]) newConv.choice_id = choice[0];
            // Each event is a snapshot; revisions need not extend the previous text.
            if (typeof choice?.[1]?.[0] === 'string' && choice[1][0]) text = choice[1][0];
            if (payload?.[3]?.['26']) newConv.at_token = payload[3]['26'];
        }
    });
    return { text, conv: newConv.conversation_id ? newConv : null };
}

async function sendMessage(jar, tokens, prompt, conv, timeoutMs, options = {}) {
    const d1 = [
        [prompt, 0, null, (options.attachments || []).map(a => [[a.uri, 1], a.name]), null, null, 0],
        ['ar'],
        buildContext(conv),
        null, null, null, [], 0, [], [], 1, 0
    ];
    const payload = {
        at: tokens.snlm0e,
        'f.req': JSON.stringify([null, JSON.stringify(d1)])
    };
    const params = {
        bl: options.buildLabel || tokens.buildLabel || GEMINI_BL,
        hl: 'ar',
        pageId: 'none',
        _reqid: String(Math.floor(Math.random() * 9_000_000) + 1_000_000),
        rt: 'c',
        'f.sid': tokens.fdrfje || ''
    };

    const headers = geminiHeaders(cookiesToString(jar.cookies));
    headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    headers['x-goog-ext-525001261-jspb'] = options.modelHeader || GEMINI_MODEL_JSPB;
    headers['x-goog-ext-73010989-jspb'] = '[0]';
    headers['x-goog-ext-73010990-jspb'] = '[0,0,0]';

    const response = await axios.post(`${GEMINI_BASE}/u/${options.accountIndex ?? 1}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`, new URLSearchParams(payload).toString(), {
        params,
        headers,
        timeout: timeoutMs || 300000,
        responseType: 'stream',
        maxRedirects: 0,
        validateStatus: s => s < 500
    });

    // كوكيز الاستجابة تُدمج دائماً (تدوير PSIDTS)
    mergeSetCookies(jar, response.headers?.['set-cookie']);

    if (response.status >= 400) {
        let errBody = '';
        response.data.on('data', c => { errBody += c.toString(); if (errBody.length > 400) response.data.destroy(); });
        await new Promise(resolve => response.data.on('end', resolve).on('close', resolve).on('error', resolve));
        throw new Error(`Gemini Web HTTP ${response.status}`);
    }

    return consumeStreamGenerate(response, conv);
}

// ---------- 🔥 إرسال رسالة في وضع الضيف (نقل حرفي لـ _gemini_fallback_send) ----------
// بدون أي حالة محادثة — كل طلب مستقل تماماً كما في البروكسي.
async function sendGuestMessage(jar, tokens, prompt, timeoutMs) {
    const d1 = [
        [prompt, 0, null, [], null, null, 0],
        ['en'],
        [null, null, null, null, null, []],
        null, null, null, [], 0, [], [], 1, 0
    ];
    const payload = {
        at: tokens.snlm0e,
        'f.req': JSON.stringify([null, JSON.stringify(d1)])
    };
    const params = {
        bl: GEMINI_GUEST_BL,
        hl: 'en',
        _reqid: String(Math.floor(Math.random() * 90_000) + 10_000),
        rt: 'c',
        'f.sid': tokens.fdrfje || ''
    };

    const headers = geminiGuestHeaders();
    headers['x-goog-ext-525001261-jspb'] = GEMINI_GUEST_MODEL_JSPB;

    const response = await axios.post(GEMINI_GUEST_STREAM_URL, new URLSearchParams(payload).toString(), {
        params,
        headers,
        timeout: timeoutMs || 300000,
        responseType: 'stream',
        maxRedirects: 0,
        validateStatus: s => s < 500
    });

    mergeSetCookies(jar, response.headers?.['set-cookie']);

    if (response.status >= 400) {
        let errBody = '';
        response.data.on('data', c => { errBody += c.toString(); if (errBody.length > 400) response.data.destroy(); });
        await new Promise(resolve => response.data.on('end', resolve).on('close', resolve).on('error', resolve));
        // رسالة صادقة: رفض Google لوضع الضيف من هذا الخادم (يحدث مع بعض عناوين IP)
        throw new GeminiWebAuthError(`رفض gemini.google.com طلب وضع الضيف (HTTP ${response.status}): ${errBody.replace(/\s+/g, ' ').substring(0, 120)} — الوصول المجهول غير متاح من هذا الخادم، أضف كوكيز حساب Google في حقل المفاتيح`);
    }

    const { text } = await consumeStreamGenerate(response, null);
    return { text };
}

// ---------- كشف القطع: هل الرد انتهى في منتصف الجملة؟ ----------
function looksIncomplete(text) {
    const t = String(text || '');
    if (t.trim().length < 200) return false; // الردود القصيرة (JSON/مراجعات) تُعتبر مكتملة
    const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
    const last = (lines[lines.length - 1] || '').replace(/[*_#`>\-]+$/g, '').trim();
    if (!last) return false;
    // علامات نهاية مقبولة للفقرات/الحوارات العربية والإنجليزية
    return !/[.!?؟…«»"”’」』)\]}:\-]$/.test(last);
}

// قصّ التداخل: إن أعاد النموذج تكرار نهاية الجزء السابق، احذف التكرار قبل الدمج
function stitchWithoutOverlap(existing, addition) {
    const a = String(existing || '');
    const b = String(addition || '');
    if (!a) return b;
    if (!b) return a;
    const maxCheck = Math.min(300, a.length, b.length);
    for (let k = maxCheck; k >= 20; k--) {
        const suffix = a.slice(-k);
        if (b.startsWith(suffix)) {
            return a + b.slice(k);
        }
    }
    const needsSpace = !/\s$/.test(a) && !/^\s/.test(b);
    return a + (needsSpace ? '\n' : '') + b;
}

// ---------- 🔥🔥🔥 وضع الضيف الكامل (بدون كوكيز) 🔥🔥🔥 ----------
// نفس سلوك fallback البروكسي: جلسة مجهولة → طلب مستقل بلا محادثة لاصقة.
// ضد القطع: بما أن وضع الضيف بلا محادثة لاصقة، إعادة الإرسال تشمل المهمة الأصلية
// كاملة + نقطة التوقف، مع منع التكرار وقصّ التداخل عند الدمج.
async function runGuestMode(prompt, { timeoutMs, log }) {
    const jar = getGuestJar();

    // 1) توكنات الجلسة المجهولة (محاولة ثانية بعد مهلة قصيرة مثل المسار المصادق)
    let tokens = await getGuestTokens(jar);
    if (!tokens) {
        await new Promise(r => setTimeout(r, 1200));
        tokens = await getGuestTokens(jar);
    }
    if (!tokens) {
        throw new GeminiWebAuthError('تعذر تشغيل وضع الضيف: لم يُعثر على توكن جلسة مجهولة في صفحة gemini.google.com (قد يكون الوصول المجهول محظوراً من هذا الخادم). أضف كوكيز حساب Google في حقل المفاتيح لتجربة موثوقة');
    }

    // 2) الطلب الأول (مستقل — بلا حالة محادثة)
    const first = await sendGuestMessage(jar, tokens, prompt, timeoutMs);
    let resultText = first.text || '';

    // 3) 🔥 إكمال تلقائي ضد القطع في وضع الضيف
    let continuationRounds = 0;
    const MAX_CONTINUATIONS = 2;
    while (looksIncomplete(resultText) && continuationRounds < MAX_CONTINUATIONS) {
        continuationRounds++;
        const tail = resultText.slice(-90).replace(/\s+/g, ' ');
        if (log) log(`الرد في وضع الضيف كان مقطوعاً — إعادة إرسال المهمة مع الإكمال من نقطة التوقف (جولة ${continuationRounds}/${MAX_CONTINUATIONS})...`, 'info');
        console.log(`[geminiWeb] guest continuation round ${continuationRounds} (text len ${resultText.length})`);
        try {
            const contPrompt = `${prompt}\n\n---\nمهمة إلحاحية: ردك السابق على هذه المهمة نفسها انقطع قبل اكتماله. آخر ما انتهى إليه النص هو: «...${tail}»\nأرسل بقية النص فقط بدءاً من النقطة التي توقفت عندها مباشرة. لا تكرر أي جملة أو فقرة سبقت، ولا تبدأ من البداية، ولا تضف مقدمات أو شرحاً — البقية فقط حتى النهاية ثم توقف.`;
            const cont = await sendGuestMessage(jar, tokens, contPrompt, timeoutMs);
            if (!cont.text || !cont.text.trim()) break;
            const before = resultText.length;
            resultText = stitchWithoutOverlap(resultText, cont.text);
            if (resultText.length <= before) break; // لم يُضف شيء جديد — توقف
        } catch (contErr) {
            console.error(`[geminiWeb] guest continuation failed: ${contErr.message}`);
            break;
        }
    }

    if (!resultText.trim()) {
        throw new Error('Gemini Web (وضع الضيف) أعاد رداً فارغاً');
    }
    return resultText;
}

// ---------- 🔥 هل هذا الفشل يعني أن الكوكيز نفسها لا تعمل (فيستحق الانتقال لوضع الضيف)؟ ----------
// - Parse Error / Header overflow: ترويسات Google الضخمة (كوكيز دوّارة) تجاوزت حد Node —
//   يُحل جذرياً برفع --max-http-header-size في سكربت التشغيل، وهنا نضمن ألا يسقط المزوّد بسببه
// - HTTP 401/403 أو GeminiWebAuthError: الكوكيز مرفوضة/ميتة
// أما 429 (RateLimited) وغيرها فتبقى صادقة بلا سقوط صامت لوضع الضيف
function isCookieLevelFailure(err) {
    const msg = String(err?.message || '');
    return err instanceof GeminiWebAuthError
        || /header overflow|parse error|hpe_header_overflow/i.test(msg)
        || /HTTP 40[13]\b/.test(msg);
}

// ---------- النقطة العامة: askGeminiWeb ----------
// options: { token (كوكيز), timeout, context (حالة المحادثة اللاصقة — نفس نمط askQwen), log }
//
// 🔥 منطق وضع الضيف (طلب المستخدم):
//   - لا كوكيز إطلاقاً / مفتاح وهمي / مفتاح لا يشبه الكوكيز → وضع الضيف مباشرة مع تنبيه واضح.
//   - كوكيز موجودة لكن جلستها فشلت → الانتقال تلقائياً إلى وضع الضيف مع تنبيه واضح
//     (نفس سطر البروكسي: "cookie-based tokens failed → switching to cookie-less fallback").
async function askGeminiWeb(prompt, options = {}) {
    const log = typeof options.log === 'function' ? options.log : null;
    const rawToken = String(options.token || '').trim();
    const isDummy = !rawToken || rawToken.startsWith('dummy-key-for-');
    const cookieLike = looksLikeGeminiCookies(rawToken);
    const timeoutMs = options.timeout || 300000;
    const context = options.context || {};
    let conv = context.geminiConv || null;

    // ============ المسار المصادق (كوكيز حقيقية) ============
    if (!isDummy && cookieLike) {
        const jar = getJar(rawToken);

        // 1) توكنات الجلسة (مع تتبّع الكوكيز الدوّارة)
        // 🔥 أي رمي خطأ (مثل Parse Error: Header overflow) يُعامل كفشل كوكيز — لا يُسقط المزوّد
        let tokens = null;
        let tokenErr = null;
        try { tokens = await getTokens(jar, options); } catch (e) { tokenErr = e; }
        if (!tokens) {
            // محاولة ثانية بعد تحديث الكوكيز من التحويلات (مثل سلوك البروكسي مع PSIDTS الجديدة)
            await new Promise(r => setTimeout(r, 1200));
            try { tokens = await getTokens(jar, options); } catch (e) { tokenErr = e; }
        }
        if (!tokens) {
            // 🔥🔥 الانتقال إلى وضع الضيف مع تنبيه واضح — طلب المستخدم صراحة:
            // "المفترض حتى لو لم تعمل الكوكيز يجب أن يعمل وضع الضيف" 🔥🔥
            if (!options.allowGuestFallback || context.geminiConv || options.attachments?.length) throw new GeminiWebAuthError('فشل توثيق حساب Gemini؛ تحقق من الكوكيز ورقم الحساب');
            const why = 'لم تتوفر جلسة حساب صالحة';
            if (log) log(`⚠️ فشل جلب جلسة Gemini بالكوكيز (${why}) — الانتقال الآن إلى وضع الضيف (بدون حساب)...`, 'warning');
            console.warn(`[geminiWeb] cookie-based tokens failed (${tokenErr?.message || 'no SNlM0e'}) → switching to GUEST mode`);
            return runGuestMode(prompt, { timeoutMs, log });
        }

        // 2) الطلب الأول — 🔥 فشل مستوى الكوكيز (Header overflow / 401 / 403) → انتقال للضيف بدلاً من إسقاط المزوّد
        let first;
        try {
            first = await sendMessage(jar, tokens, prompt, conv, timeoutMs, options);
        } catch (sendErr) {
            if (isCookieLevelFailure(sendErr) && options.allowGuestFallback && !context.geminiConv && !options.attachments?.length) {
                if (log) log(`⚠️ فشل إرسال Gemini Web بالكوكيز (${sendErr.message}) — الانتقال الآن إلى وضع الضيف (بدون حساب)...`, 'warning');
                console.warn(`[geminiWeb] authed send failed (${sendErr.message}) → switching to GUEST mode`);
                return runGuestMode(prompt, { timeoutMs, log });
            }
            throw sendErr;
        }
        let { text, conv: newConv } = first;
        conv = newConv;
        if (context) context.geminiConv = conv;
        let resultText = text || '';

        // 3) 🔥 الإكمال التلقائي ضد القطع ("يترجم نصفه / آخره كأنه انقطع")
        let continuationRounds = 0;
        const MAX_CONTINUATIONS = 2;
        while (options.autoContinue !== false && looksIncomplete(resultText) && continuationRounds < MAX_CONTINUATIONS) {
            continuationRounds++;
            const tail = resultText.slice(-90).replace(/\s+/g, ' ');
            if (log) log(`الرد كان مقطوعاً في نهايته — جاري الإكمال تلقائياً في نفس المحادثة (جولة ${continuationRounds}/${MAX_CONTINUATIONS})...`, 'info');
            console.log(`[geminiWeb] continuation round ${continuationRounds} (text len ${resultText.length})`);
            try {
                const contPrompt = `أكمل المهمة السابقة من حيث توقفت تماماً. ابدأ مباشرة بعد نهاية النص السابق الذي انتهى بـ: «...${tail}»\nلا تكرر أي جملة أو فقرة سبقت، ولا تعِد الترجمة من البداية، ولا تضف مقدمات أو شرحاً — أكمل النص فقط حتى نهايته ثم توقف.`;
                const cont = await sendMessage(jar, tokens, contPrompt, conv, timeoutMs, { ...options, attachments: [] });
                if (!cont.text || !cont.text.trim()) break;
                conv = cont.conv || conv;
                if (context) context.geminiConv = conv;
                const before = resultText.length;
                resultText = stitchWithoutOverlap(resultText, cont.text);
                if (resultText.length <= before) break; // لم يُضف شيء جديد — توقف
            } catch (contErr) {
                console.error(`[geminiWeb] continuation failed: ${contErr.message}`);
                break;
            }
        }

        if (!resultText.trim()) {
            throw new Error('Gemini Web أعاد رداً فارغاً');
        }
        return resultText;
    }

    if (!options.allowGuestFallback) throw new GeminiWebAuthError('كوكيز حساب Gemini مطلوبة؛ وضع الضيف غير مفعّل');
    if (options.attachments?.length || context.geminiConv) throw new GeminiWebAuthError('Guest mode cannot preserve selected conversations or attachments');

    // ============ وضع الضيف من البداية (تنبيه واضح قبل الدخول) ============
    if (log) {
        if (!isDummy) {
            log('⚠️ المفتاح المُدخل لا يبدو كوكيز Gemini صالحة (يجب أن يحتوي __Secure-1PSID=...) — سيتم استخدام وضع الضيف (بدون حساب) بدلاً منه', 'warning');
        } else {
            log('🟡 وضع الضيف: لا توجد كوكيز Gemini — سيتم استخدام الوصول المجهول (بدون حساب) إلى gemini.google.com', 'warning');
        }
    }
    console.warn(`[geminiWeb] entering GUEST mode (reason: ${isDummy ? 'no-cookies' : 'key-not-cookie-like'})`);
    return runGuestMode(prompt, { timeoutMs, log });
}

module.exports = { askGeminiWeb, GeminiWebAuthError, GUEST_TOKEN_SENTINEL, looksLikeGeminiCookies, consumeStreamGenerate, uploadGeminiAttachment, extractSessionTokens, getJar, getTokens, geminiHeaders, cookiesToString, mergeSetCookies };

async function uploadGeminiAttachment(token, file) {
    if (!looksLikeGeminiCookies(token)) throw new GeminiWebAuthError('Gemini account cookies are required for uploads');
    const jar = getJar(token);
    const headers = { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(file.buffer.length), 'X-Tenant-Id': 'bard-storage',
        'Push-ID': 'feeds/mcudyrk2a4khkz', 'X-Client-Pctx': 'CgcSBWjK7pYx',
        'Authorization': 'Basic c2F2ZXM6cyNMdGhlNmxzd2F2b0RsN3J1d1U=',
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        Origin: GEMINI_BASE, Referer: GEMINI_BASE + '/', 'User-Agent': geminiHeaders('')['user-agent'],
        Cookie: cookiesToString(jar.cookies) };
    const init = await axios.post('https://push.clients6.google.com/upload/', 'File name: ' + file.originalname, { headers, timeout: 60000 });
    const uploadUrl = init.headers['x-goog-upload-url'] || init.headers['x-goog-upload-control-url'];
    if (!uploadUrl) throw new Error('Gemini returned no upload URL');
    const url = new URL(uploadUrl);
    if (url.protocol !== 'https:' || !(url.hostname === 'google.com' || url.hostname.endsWith('.google.com'))) throw new Error('Unexpected Gemini upload host');
    const result = await axios.post(url.href, file.buffer, { headers: { ...headers,
        'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0',
        'Content-Type': file.mimetype || 'application/octet-stream' }, timeout: 300000 });
    const uri = typeof result.data === 'string' ? result.data.trim() : '';
    if (!uri) throw new Error('Gemini returned no file identifier');
    return { uri, name: file.originalname, mime: file.mimetype, kind: file.mimetype?.startsWith('image/') ? 'image' : 'file' };
}
