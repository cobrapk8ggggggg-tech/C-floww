// 🔥 Qwen Auto-Account service — نسخة Node.js من طريقة qwen.py المجرّبة:
//   1) إنشاء بريد مؤقت (temp-mail.io كما في qwen.py + mail.tm كاحتياطي مجرّب)
//   2) التسجيل في chat.qwen.ai/api/v2/auths/signup بنفس User-Agent تطبيق أندرويد
//   3) انتظار رسالة التفعيل واستخراج رابط chat.qwen.ai/api/v1/auths/activate?...
//   4) تفعيل الحساب (بترويسات متصفح كاملة — مجرّب أنها تتجاوز قيود الحماية)
//      ثم تسجيل الدخول /auths/signin للحصول على التوكن
// المستخدم: "مهما فشل يستطيع عمل حساب جديد وتكملة الترجمة — Qwen فقط".
// الحسابات تُخزَّن بشكل دائم في Settings.qwenAutoAccounts (القرص على Railway مؤقت).
const axios = require('axios');
const crypto = require('crypto');
const Settings = require('../models/settings.model.js');

const TEMP_MAIL_API = 'https://api.internal.temp-mail.io/api/v3';
const MAILTM_API = 'https://api.mail.tm';
const QWEN_BASE = 'https://chat.qwen.ai/api/v2';
// نفس كلمة المرور الثابتة في qwen.py (لا تُغيَّر حتى تبقى الحسابات متوافقة)
const QWEN_ACCOUNT_PASSWORD = '899409576f885e962bb8aecc95ed24efc9b46a0872fdd8e79ed1d6fd72aeb358';
// نفس User-Agent تطبيق Qwen أندرويد المستخدم في qwen.py
const QWEN_APP_UA = 'Dalvik/2.1.0 (Linux; U; Android 16; CPH2631 Build/BP2A.250605.015) AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite';
const BROWSER_UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36'
];
// ترويسات متصفح كاملة لرابط التفعيل (مجرّب: تتجاوز قيد "restricted as a security measure")
const ACTIVATION_BROWSER_HEADERS = {
    'User-Agent': BROWSER_UAS[0],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://chat.qwen.ai/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pickBrowserUa = () => BROWSER_UAS[Math.floor(Math.random() * BROWSER_UAS.length)];

// ---------- Store (in-memory + Settings persistence) ----------
let store = [];
let storeLoaded = false;
let storeLoadPromise = null;

// توكنات يُرسلها المستخدم يدوياً (ليست من حساباتنا) — نوسمها في الذاكرة فقط لهذه العملية
const ephemeralLimited = new Map(); // token -> untilTs
const ephemeralDead = new Set();

function normalizeAccount(a) {
    return {
        email: String(a?.email || ''),
        password: String(a?.password || QWEN_ACCOUNT_PASSWORD),
        token: String(a?.token || ''),
        // 🔥 مالك الحساب: كل مزوّد Qwen يحصل على حسابه الخاص المستقل.
        // بدون هذا الحقل كان الحساب الأول يُعاد استخدامه لكل المزوّدين (بلاغ المستخدم 1).
        providerId: String(a?.providerId || ''),
        createdAt: a?.createdAt ? new Date(a.createdAt) : new Date(),
        rateLimitedUntil: a?.rateLimitedUntil ? new Date(a.rateLimitedUntil) : null,
        dead: !!a?.dead
    };
}

async function loadStore() {
    if (storeLoaded) return store;
    if (!storeLoadPromise) {
        storeLoadPromise = (async () => {
            try {
                const settings = await Settings.findOne().select('qwenAutoAccounts').lean();
                store = (settings?.qwenAutoAccounts || []).map(normalizeAccount).filter(a => a.token);
            } catch (e) {
                console.error('[qwenAutoAccount] failed to load accounts:', e.message);
                store = [];
            }
            storeLoaded = true;
        })();
    }
    await storeLoadPromise;
    return store;
}

// 🔥 طابور كتابة واحد مُتسلسل لكل تعديلات Settings من هذه الخدمة.
// سبب الجذري (بلاغ المستخدم 2): حفظان متوازيان لنفس المستند يرميان Mongoose VersionError
// فتضيع وسوم RateLimited/dead بصمت ويعود الحساب الميت "صالحاً" بعد إعادة تشغيل الخدمة.
let settingsWriteChain = Promise.resolve();
function enqueueSettingsWrite(task) {
    const run = settingsWriteChain.then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await task();
                return true;
            } catch (e) {
                const retryable = e?.name === 'VersionError' || /version/i.test(String(e?.message || ''));
                console.error(`[qwenAutoAccount] settings write failed (attempt ${attempt + 1}):`, e.message);
                if (!retryable || attempt === 2) return false;
                await delay(300);
            }
        }
        return false;
    }).catch(() => false);
    settingsWriteChain = run;
    return run;
}

function persistAccountsSerialized() {
    return enqueueSettingsWrite(async () => {
        const settings = await Settings.findOne();
        if (!settings) return;
        settings.qwenAutoAccounts = store.map(a => ({
            email: a.email,
            password: a.password,
            token: a.token,
            providerId: a.providerId,
            createdAt: a.createdAt,
            rateLimitedUntil: a.rateLimitedUntil,
            dead: a.dead
        }));
        await settings.save();
    });
}

function isAccountUsable(account) {
    if (!account || account.dead || !account.token) return false;
    if (account.rateLimitedUntil && new Date(account.rateLimitedUntil).getTime() > Date.now()) return false;
    return true;
}

function getUsableAccounts() {
    return store.filter(isAccountUsable);
}

function isTokenEphemeralLimited(token) {
    const until = ephemeralLimited.get(token);
    if (!until) return false;
    if (until <= Date.now()) { ephemeralLimited.delete(token); return false; }
    return true;
}

// تُرجع فقط التوكنات القابلة للاستخدام الآن (تستبعد الميتة/المستهلكة الموسومة).
// 🔥 وعي الملكية: توكن حساب تلقائي مملوك لمزوّد آخر يُستبعد من هذا المزوّد —
// كل مزوّد Qwen يعمل على حساباته هو فقط (بلاغ المستخدم 1: ثلاثة مزوّدين بنفس الحساب).
// التوكنات غير الموجودة في المخزن (مُدخلة يدوياً) تبقى صالحة لمزوّدها.
function filterUsableQwenTokens(tokens, providerId = '') {
    const owner = String(providerId || '');
    return (Array.isArray(tokens) ? tokens : []).filter(token => {
        if (!token || token.startsWith('dummy-key-for-')) return false;
        const account = store.find(a => a.token === token);
        if (account) return isAccountUsable(account) && account.providerId === owner;
        if (ephemeralDead.has(token)) return false;
        if (isTokenEphemeralLimited(token)) return false;
        return true;
    });
}

function markTokenRateLimited(token, hours = 24) {
    if (!token || token.startsWith('dummy-key-for-')) return;
    const account = store.find(a => a.token === token);
    if (account) {
        account.rateLimitedUntil = new Date(Date.now() + hours * 3600 * 1000);
        persistAccountsSerialized();
    } else {
        ephemeralLimited.set(token, Date.now() + hours * 3600 * 1000);
    }
}

function markTokenDead(token) {
    if (!token || token.startsWith('dummy-key-for-')) return;
    const account = store.find(a => a.token === token);
    if (account) {
        account.dead = true;
        persistAccountsSerialized();
    } else {
        ephemeralDead.add(token);
    }
}

// 🔥 التصنيف الشامل لأي فشل توليد بتوكن Qwen — قاتل حلقة "نفس الحساب" (بلاغ المستخدم 2):
//   RateLimited → وسم 24 ساعة (مثل qwen.py)
//   فشل مصادقة → ميت نهائياً
//   خطأ شبكة عابر (timeout/انقطاع/5xx) → لا وسم (الحساب سليم)
//   أي خطأ آخر غير مصنّف → موسم قصير 30 دقيقة (شبكة أمان: الحساب الفاشل لا يُعاد استخدامه
//     فوراً أبداً، ويتعافى تلقائياً بعد نصف ساعة إن كان الخطأ مؤقتاً)
function isTransientNetworkError(err) {
    if (!err) return false;
    const code = String(err.code || '');
    if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return true;
    const status = err.response?.status;
    if (status && status >= 500) return true;
    return /timeout|timed out|network|socket hang up|connection (refused|reset|closed)/i.test(String(err.message || ''));
}

function markTokenFailure(token, err) {
    if (!token || token.startsWith('dummy-key-for-')) return 'skipped';
    if (err && err.name === 'QwenRateLimitedError') { markTokenRateLimited(token, 24); return 'rate-limited-24h'; }
    if (err && err.name === 'QwenAuthError') { markTokenDead(token); return 'dead'; }
    if (isTransientNetworkError(err)) return 'transient';
    markTokenRateLimited(token, 0.5);
    return 'limited-30m';
}

// إضافة التوكن لمزوّد Qwen في الإعدادات بشكل دائم (يظهر للمستخدم في حقل التوكنات)
// تمر عبر نفس الطابور المتسلسل لمنع VersionError مع حفظ وسوم الحسابات.
async function persistProviderToken(providerId, token) {
    if (!providerId || !token) return;
    await enqueueSettingsWrite(async () => {
        const settings = await Settings.findOne();
        if (!settings) return;
        const prov = (settings.translationProviders || []).find(p => p.providerId === providerId);
        if (!prov) return;
        prov.qwenTokens = Array.isArray(prov.qwenTokens) ? prov.qwenTokens : [];
        if (!prov.qwenTokens.includes(token)) prov.qwenTokens.push(token);
        settings.markModified('translationProviders');
        await settings.save();
    });
}

// ---------- Temp email providers (مع تجاوز تلقائي عند فشل أحدها) ----------

// (أ) temp-mail.io — نفس مصدر qwen.py
async function createTempMailIoEmail() {
    try {
        const r = await axios.post(`${TEMP_MAIL_API}/email/new`,
            { min_name_length: 10, max_name_length: 10 },
            { headers: { 'User-Agent': pickBrowserUa(), 'Content-Type': 'application/json' }, timeout: 20000 });
        if (r.status === 200 && r.data?.email) {
            return { provider: 'tempmail', email: r.data.email, token: r.data.token || '' };
        }
    } catch (e) {
        console.error('[qwenAutoAccount] temp-mail.io create failed:', e.message);
    }
    return null;
}

// (ب) mail.tm — احتياطي مجرّب (وصول كامل عبر توكن Bearer)
async function createMailTmEmail() {
    try {
        const domainsRes = await axios.get(`${MAILTM_API}/domains`, { headers: { 'User-Agent': pickBrowserUa() }, timeout: 20000 });
        const domains = (domainsRes.data?.['hydra:member'] || domainsRes.data?.member || domainsRes.data || [])
            .filter(d => d && d.domain && d.isActive !== false && d.isPrivate === false);
        if (!domains.length) return null;
        const address = `zx${crypto.randomBytes(6).toString('hex')}@${domains[0].domain}`;
        const password = crypto.randomBytes(12).toString('hex');
        await axios.post(`${MAILTM_API}/accounts`, { address, password },
            { headers: { 'User-Agent': pickBrowserUa(), 'Content-Type': 'application/json' }, timeout: 20000 });
        const tokenRes = await axios.post(`${MAILTM_API}/token`, { address, password },
            { headers: { 'User-Agent': pickBrowserUa(), 'Content-Type': 'application/json' }, timeout: 20000 });
        if (tokenRes.data?.token) {
            return { provider: 'mailtm', email: address, token: tokenRes.data.token };
        }
    } catch (e) {
        console.error('[qwenAutoAccount] mail.tm create failed:', e.message);
    }
    return null;
}

// جلب أجسام الرسائل من صندوق البريد المؤقت حسب المزوّد
async function fetchMessageBodies(emailCtx) {
    if (!emailCtx) return [];
    if (emailCtx.provider === 'mailtm') {
        const headers = { 'User-Agent': pickBrowserUa(), 'Authorization': `Bearer ${emailCtx.token}` };
        const r = await axios.get(`${MAILTM_API}/messages`, { headers, timeout: 20000 });
        const list = r.data?.['hydra:member'] || r.data?.member || r.data || [];
        const bodies = [];
        for (const m of list) {
            try {
                const full = await axios.get(`${MAILTM_API}/messages/${m.id}`, { headers, timeout: 20000 });
                const html = Array.isArray(full.data?.html) ? full.data.html.join('') : (full.data?.html || '');
                bodies.push(full.data?.text || html || '');
            } catch (_) { /* skip single message */ }
        }
        return bodies;
    }
    // tempmail.io
    const r = await axios.get(`${TEMP_MAIL_API}/email/${encodeURIComponent(emailCtx.email)}/messages`,
        { headers: { 'User-Agent': pickBrowserUa() }, timeout: 20000 });
    const list = Array.isArray(r.data) ? r.data : [];
    return list.map(m => m?.body_text || m?.body_html || m?.body || '');
}

// إنشاء بريد مؤقت + التأكد أن صندوق الوارد يستجيب فعلاً قبل إهدار تسجيل Qwen عليه
async function createVerifiedTempEmail() {
    const providers = [createTempMailIoEmail, createMailTmEmail];
    for (const createFn of providers) {
        const ctx = await createFn();
        if (!ctx) continue;
        try {
            await fetchMessageBodies(ctx); // فحص الوصول
            return ctx;
        } catch (e) {
            console.error(`[qwenAutoAccount] inbox unreachable (${ctx.provider}): ${e.message} — تجربة المزوّد التالي`);
        }
    }
    return null;
}

async function waitForActivationLink(emailCtx, maxAttempts = 10, delayMs = 4000) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const bodies = await fetchMessageBodies(emailCtx);
            for (const body of bodies) {
                const match = String(body).match(/https:\/\/chat\.qwen\.ai\/api\/v1\/auths\/activate\?[^\s)"'<>]+/);
                if (match) return match[0].replace(/[)\].,]+$/, '');
            }
        } catch (_) { /* retry */ }
        await delay(delayMs);
    }
    return null;
}

// ---------- qwen.py flow ----------
function appHeaders(contentType = 'application/json') {
    const headers = { 'User-Agent': QWEN_APP_UA };
    if (contentType) headers['Content-Type'] = contentType;
    return headers;
}

async function signupQwen(email, name, password) {
    try {
        const r = await axios.post(`${QWEN_BASE}/auths/signup`, {
            name,
            email,
            password,
            profile_image_url: '',
            oauth_sub: '',
            oauth_token: ''
        }, { headers: appHeaders(), timeout: 25000, validateStatus: s => s < 500 });
        return r.status === 200 || r.status === 201;
    } catch (e) {
        console.error('[qwenAutoAccount] signup failed:', e.message);
        return false;
    }
}

async function activateAccount(activationUrl) {
    // الاستراتيجية 1: ترويسات متصفح كاملة (مجرّب: تعمل حتى من سيرفرات datacenter)
    // الاستراتيجية 2: طلب qwen.py البسيط
    const strategies = [
        { label: 'browser-full', headers: ACTIVATION_BROWSER_HEADERS },
        { label: 'plain-browser', headers: { 'User-Agent': pickBrowserUa() } }
    ];
    for (const strategy of strategies) {
        try {
            const r = await axios.get(activationUrl, {
                headers: strategy.headers, timeout: 30000, validateStatus: s => s < 500, maxRedirects: 5
            });
            if (r.status === 200 || r.status === 201) return true;
            console.error(`[qwenAutoAccount] activate (${strategy.label}) status ${r.status}: ${JSON.stringify(r.data).substring(0, 150)}`);
        } catch (e) {
            console.error(`[qwenAutoAccount] activate (${strategy.label}) error: ${e.message}`);
        }
    }
    return false;
}

async function signinQwen(email, password) {
    try {
        const r = await axios.post(`${QWEN_BASE}/auths/signin`, { email, password },
            { headers: appHeaders(), timeout: 25000 });
        if (r.status === 200 && r.data?.success && r.data?.data?.token) return r.data.data.token;
        console.error(`[qwenAutoAccount] signin rejected: ${JSON.stringify(r.data).substring(0, 150)}`);
    } catch (e) {
        console.error('[qwenAutoAccount] signin failed:', e.message);
    }
    return null;
}

// نفس منطق qwen.py: 5 محاولات كاملة (بريد → تسجيل → تفعيل → دخول) قبل الاستسلام
// ownerProviderId: المزوّد الذي يملك هذا الحساب حصرياً
async function createQwenAccountInternal(ownerProviderId = '') {
    const name = 'User_' + crypto.randomBytes(8).toString('hex').substring(0, 6);
    let lastError = '';
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const emailCtx = await createVerifiedTempEmail();
            if (!emailCtx) { lastError = 'لا يوجد مزوّد بريد مؤقت متاح'; continue; }
            console.log(`[qwenAutoAccount] attempt ${attempt + 1}: temp email ${emailCtx.email} (${emailCtx.provider})`);

            if (!await signupQwen(emailCtx.email, name, QWEN_ACCOUNT_PASSWORD)) { lastError = 'فشل التسجيل في Qwen'; continue; }

            const activationLink = await waitForActivationLink(emailCtx);
            if (!activationLink) { lastError = 'لم تصل رسالة التفعيل'; continue; }

            if (!await activateAccount(activationLink)) { lastError = 'فشل تفعيل الحساب'; continue; }

            const token = await signinQwen(emailCtx.email, QWEN_ACCOUNT_PASSWORD);
            if (token) {
                const account = normalizeAccount({ email: emailCtx.email, password: QWEN_ACCOUNT_PASSWORD, token, providerId: String(ownerProviderId || '') });
                store.push(account);
                await persistAccountsSerialized();
                console.log(`[qwenAutoAccount] ✅ created Qwen account ${emailCtx.email}`);
                return account;
            }
            lastError = 'فشل تسجيل الدخول بعد التفعيل';
        } catch (e) {
            lastError = e.message;
            console.error('[qwenAutoAccount] attempt error:', e.message);
        }
    }
    throw new Error(`فشل إنشاء حساب Qwen جديد بعد عدة محاولات (${lastError})`);
}

//Serialize creation: لو نداءان متوازيان للـ نفس المزوّد، الثاني يعيد استخدام الحساب الجديد بدل إنشاء اثنين.
// 🔥 providerId إلزامي عملياً: إعادة الاستخدام تقتصر على حسابات هذا المزوّد هو فقط،
// وكل مزوّد بلا حساب صالح يحصل على حساب جديد كلياً مختلف (بلاغ المستخدم 1).
// 🔥 opts.forceNew: بعد فشل ترجمة فعلية يُنشأ حساب جديد كلياً دائماً بدل إعادة نفس
// الحساب الفاشل — يكسر حلقة "يقول إنه أنشأ حساباً لكنه نفس الحساب" (بلاغ المستخدم 2).
// تُرجع { account, created } — created=true فقط عند إنشاء فعلي جديد (للرسائل الصادقة).
let creationChain = Promise.resolve();
function ensureQwenAccount(providerId, opts = {}) {
    const run = creationChain
        .catch(() => {})
        .then(async () => {
            await loadStore();
            const owner = String(providerId || '');
            if (!opts.forceNew) {
                const owned = store.filter(a => a.providerId === owner && isAccountUsable(a));
                if (owned.length > 0) return { account: owned[owned.length - 1], created: false };
            }
            const account = await createQwenAccountInternal(owner);
            return { account, created: true };
        });
    creationChain = run.catch(() => {});
    return run;
}

module.exports = {
    ensureQwenAccount,
    filterUsableQwenTokens,
    markTokenRateLimited,
    markTokenDead,
    markTokenFailure,
    persistProviderToken,
    getUsableAccounts,
    isAccountUsable
};
