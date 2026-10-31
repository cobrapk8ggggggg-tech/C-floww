const axios = require('axios');

// 🔥 تحديث 2.1.0 (أكتوبر 2026): تطبيق ديبسيك تحدّث وخوادم POW القديمة (Railway/Ngrok) ماتت (404).
// البروتوكول المُتحقَّق منه حياً: تطبيق أندرويد 2.1.0 + وكيل POW الجديد الذي يعيد
// x_ds_pow_response + solved_json معاً، والحِمولة الجديدة (audio_id + معاملات التوليد)
// بدون حقل pow في الجسم (الإثبات في الترويسة x-ds-pow-response فقط).
const DEFAULT_DEEPSEEK_TOKEN = process.env.DEEPSEEK_APP_TOKEN || '';
const DEFAULT_POW_URL = process.env.DEEPSEEK_POW_URL || 'https://deepseek-pow.contact-3mh.workers.dev/get_pow';

function removeDeepSeekFinishedMarker(text) {
    return (text || '').replace(/(?:\r?\n|\s)*FINISHED\s*$/i, '').trim();
}

function generateDeviceId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    for (let i = 0; i < 88; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function generateRangersId() {
    const ts = BigInt(Date.now());
    const rv = BigInt(Math.floor(1000000000 + Math.random() * 8999999999));
    return ((ts << 32n) | rv).toString();
}

function getTzOffset() {
    return (new Date().getTimezoneOffset() * -60).toString();
}

function buildFullHeaders(token, powResponse) {
    // نفس ترويسات تطبيق أندرويد 2.1.0 المُتحقَّق منها حياً — أي ترويسات إضافية
    // قديمة (x-device-id/x-os-version) أُسقطت لأن الويب الحي يعمل بدونها تماماً.
    return {
        'User-Agent': 'DeepSeek/2.1.0 Android/36',
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/json',
        'x-client-platform': 'android',
        'x-client-version': '2.1.0',
        'x-client-locale': 'ar',
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-rangers-id': '7693812033879281421',
        'x-client-timezone-offset': getTzOffset(),
        'Authorization': `Bearer ${token}`,
        'X-DS-PoW-Response': powResponse,
        'accept-charset': 'UTF-8'
    };
}

function buildPowRequestUrl(powUrl, token) {
    const value = powUrl || DEFAULT_POW_URL;
    const cleanUrl = value.includes('/get_pow') ? value.split('?')[0] : value;
    if (!cleanUrl.includes('/get_pow')) return cleanUrl;

    const separator = cleanUrl.includes('?') ? '&' : '?';
    return `${cleanUrl}${separator}authorization=${encodeURIComponent(`Bearer ${token}`)}`;
}

async function getFreshPow(powUrl, token) {
    const response = await axios.get(buildPowRequestUrl(powUrl, token), { timeout: 60000 });
    const powResponse = response.data?.pow_response || response.data?.x_ds_pow_response;
    const powData = response.data?.solved_json;

    if (!powResponse) {
        throw new Error(`DeepSeek POW response is incomplete: ${JSON.stringify(response.data)}`);
    }
    return {
        powResponse,
        powData
    };
}

async function createChatSession(token) {
    // نفس نداء التطبيق: POST بجسم فارغ وبنفس ترويسات الأندرويد
    const response = await axios.post('https://chat.deepseek.com/api/v0/chat_session/create', {}, {
        headers: {
            'User-Agent': 'DeepSeek/2.1.0 Android/36',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'x-client-platform': 'android',
            'x-client-version': '2.1.0',
            'x-client-locale': 'ar',
            'x-client-bundle-id': 'com.deepseek.chat',
            'x-rangers-id': '7693812033879281421',
            'x-client-timezone-offset': getTzOffset(),
            'Authorization': `Bearer ${token}`,
            'accept-charset': 'UTF-8'
        },
        timeout: 60000
    });
    const sessionId = response.data?.data?.biz_data?.chat_session?.id;
    if (!sessionId) throw new Error(`DeepSeek session id missing: ${JSON.stringify(response.data)}`);
    return sessionId;
}

function parseDeepSeekLine(line, state) {
    if (!line.startsWith('data: ')) return;
    const rawChunk = line.substring(6);
    let item;
    try { item = JSON.parse(rawChunk); } catch (_) { return; }

    if (item?.request_message_id) state.requestMessageId = item.request_message_id;
    if (item?.response_message_id) state.responseMessageId = item.response_message_id;

    // 🔥 HARDENED PARSER (fixes corrupted translations):
    // 1) Patch operations (p + o) are handled EXCLUSIVELY here — only APPENDs on a
    //    ".../content" path are added. This prevents the literal words "RESPONSE"/
    //    "THINKING" (type patches with o:"=") from being injected into the chapter.
    // 2) The old code appended string deltas TWICE (generic v-append + explicit
    //    APPEND handler). Patches and snapshots are now mutually exclusive branches.
    if (item?.p !== undefined && item?.o !== undefined) {
        if (item.o === 'APPEND' && typeof item.v === 'string' && /\/content$/.test(String(item.p))) {
            state.text += item.v;
        }
        return;
    }

    // Snapshot / bare delta (no patch path)
    if (item?.v !== undefined) {
        if (typeof item.v === 'string') {
            state.text += item.v;
        } else if (typeof item.v === 'object' && item.v.response?.fragments) {
            for (const frag of item.v.response.fragments) {
                if (frag.type === 'RESPONSE') state.text += frag.content || '';
                if (frag.type === 'THINKING') state.thinking += frag.content || '';
                if (frag.type === 'SEARCH' && Array.isArray(frag.results)) state.searchResults = frag.results;
            }
        }
    }
}

async function askDeepSeek(prompt, options = {}) {
    const token = options.token || DEFAULT_DEEPSEEK_TOKEN;
    if (!token) throw new Error('A DeepSeek account token is required');
    const powUrl = options.powUrl || DEFAULT_POW_URL;
    const context = options.context || {};
    const sessionId = context.sessionId || options.sessionId || await createChatSession(token);
    const parentMessageId = context.parentMessageId || options.parentMessageId || null;
    const { powResponse, powData } = await getFreshPow(powUrl, token);

    const response = await axios.post('https://chat.deepseek.com/api/v0/chat/completion', {
        // الحمولة الجديدة المُتحقَّق منها حياً (نفس تطبيق أندرويد 2.1.0):
        // لا حقل pow في الجسم (الإثبات يُرسل في الترويسة فقط) + معاملات التوليد الكاملة.
        chat_session_id: sessionId,
        parent_message_id: parentMessageId || undefined,
        prompt,
        ref_file_ids: [],
        thinking_enabled: Boolean(options.thinkingEnabled),
        search_enabled: Boolean(options.searchEnabled),
        audio_id: null,
        preempt: false,
        model_type: options.modelType === 'expert' ? 'expert' : null,
        temperature: typeof options.temperature === 'number' ? options.temperature : 0.7,
        max_tokens: typeof options.maxTokens === 'number' ? options.maxTokens : 2048,
        top_p: typeof options.topP === 'number' ? options.topP : 0.9,
        frequency_penalty: typeof options.frequencyPenalty === 'number' ? options.frequencyPenalty : 0.0,
        presence_penalty: typeof options.presencePenalty === 'number' ? options.presencePenalty : 0.0,
        stream: true
    }, {
        headers: buildFullHeaders(token, powResponse),
        timeout: options.timeout || 500000,
        responseType: 'stream'
    });

    const state = { text: '', thinking: '', searchResults: [] };
    await new Promise((resolve, reject) => {
        response.data.on('data', chunk => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) parseDeepSeekLine(line.trim(), state);
        });
        response.data.on('end', resolve);
        response.data.on('error', reject);
    });

    state.text = removeDeepSeekFinishedMarker(state.text);

    if (!state.text.trim()) throw new Error('DeepSeek returned an empty response');

    if (options.context) {
        options.context.sessionId = sessionId;
        if (state.responseMessageId) options.context.parentMessageId = state.responseMessageId;
        if (state.requestMessageId) options.context.requestMessageId = state.requestMessageId;
        options.context.lastUpdated = new Date();
    }

    return state.text;
}

module.exports = { askDeepSeek };