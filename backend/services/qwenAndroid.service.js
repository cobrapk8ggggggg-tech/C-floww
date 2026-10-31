const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const BASE = 'https://chat.qwen.ai';
const DEFAULT_MODEL = process.env.QWEN_MODEL || 'qwen3.8-max';
const DEFAULT_TOKEN = process.env.QWEN_AUTH_TOKEN || '';
const DEFAULT_COOKIES = process.env.QWEN_COOKIES_STR || '';
const DEFAULT_DEVICE_ID = process.env.QWEN_DEVICE_ID || 'ai41028e1f8c77e8b2786e747bbb688d45';
const DEFAULT_MINI_WUA_NEW = process.env.QWEN_MINI_WUA_NEW || '';
const DEFAULT_MINI_WUA_CHAT = process.env.QWEN_MINI_WUA_CHAT || '';
const DEFAULT_APP_WAF = process.env.QWEN_APP_WAF || '';

// 🔥 تصنيف أخطاء Qwen ليقرأها نظام الحساب التلقائي (qwenAutoAccount.service.js):
// RateLimited → وسم الحساب مستهلكاً 24 ساعة وإنشاء حساب بديل فوراً
// QwenAuthError → توكن غير صالح (مصادقة) ووسمه ميتاً
class QwenRateLimitedError extends Error {
    constructor(message) {
        super(message || 'Qwen RateLimited: تم استهلاك حد الحساب');
        this.name = 'QwenRateLimitedError';
    }
}
class QwenAuthError extends Error {
    constructor(message) {
        super(message || 'Qwen auth failed: التوكن غير صالح');
        this.name = 'QwenAuthError';
    }
}

function looksRateLimited(payload) {
    try {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        return text.includes('RateLimited');
    } catch (_) { return false; }
}

function looksAuthError(payload) {
    try {
        const text = typeof payload === 'string' ? payload.toLowerCase() : JSON.stringify(payload).toLowerCase();
        return /unauthorized|invalid token|token.*invalid|authorization failed|not authenticated|login required/.test(text);
    } catch (_) { return false; }
}

// توحيد أخطاء axios من نداءات Qwen إلى أخطاء مصنّفة
function classifyQwenAxiosError(err, fallbackMessage) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    if (looksRateLimited(data) || status === 429) throw new QwenRateLimitedError(`Qwen RateLimited (HTTP ${status || '?'})`);
    if (status === 401 || status === 403 || looksAuthError(data)) throw new QwenAuthError(`Qwen auth failed (HTTP ${status || '?'})`);
    throw err;
}

function parseCookies(cookiesStr = '') {
    return cookiesStr.split(';').reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx > 0) acc[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
        return acc;
    }, {});
}

function buildCookieHeader(token, cookiesStr) {
    const cookies = parseCookies(cookiesStr || DEFAULT_COOKIES);
    cookies['x-ap'] = cookies['x-ap'] || 'eu-central-1';
    if (token) cookies.token = token;
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function headers(kind, options = {}) {
    const token = options.token || DEFAULT_TOKEN;
    const h = {
        'X-Platform': 'android',
        Accept: kind === 'chat' ? '*/*,text/event-stream' : 'application/json',
        'User-Agent': kind === 'chat'
            ? 'Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2) AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite,Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2)'
            : 'Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2),Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2) AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite',
        'x-device-id': options.deviceId || DEFAULT_DEVICE_ID,
        source: 'app',
        'x-mini-wua': kind === 'chat' ? (options.miniWuaChat || DEFAULT_MINI_WUA_CHAT) : (options.miniWuaNew || DEFAULT_MINI_WUA_NEW),
        'x-request-id': uuidv4(),
        'Accept-Language': 'en-US',
        'Accept-Charset': 'UTF-8',
        'Content-Type': kind === 'chat' ? 'application/json; charset=UTF-8' : 'application/json',
        Host: 'chat.qwen.ai',
        Connection: 'Keep-Alive',
        'Accept-Encoding': 'gzip, deflate',
        Cookie: buildCookieHeader(token, options.cookies)
    };
    if (kind === 'chat') {
        h['Cache-Control'] = 'no-store';
        if (options.appWaf || DEFAULT_APP_WAF) h.app_waf = options.appWaf || DEFAULT_APP_WAF;
    }
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
}

async function createChat(options = {}) {
    let res;
    try {
        res = await axios.post(`${BASE}/api/v2/chats/new`, { chat_mode: 'normal', project_id: '' }, {
            headers: headers('new', options), timeout: options.timeout || 60000
        });
    } catch (err) {
        classifyQwenAxiosError(err, 'Qwen chat creation failed');
    }
    if (looksRateLimited(res.data)) throw new QwenRateLimitedError('Qwen RateLimited أثناء إنشاء المحادثة');
    if (looksAuthError(res.data)) throw new QwenAuthError('Qwen auth failed أثناء إنشاء المحادثة');
    const id = res.data?.chat_id || res.data?.id || res.data?.data?.chat_id || res.data?.data?.id;
    if (!id) throw new Error(`Qwen chat_id missing: ${JSON.stringify(res.data)}`);
    return id;
}

function extractText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return obj.map(extractText).join('');
    if (typeof obj !== 'object') return '';
    const paths = [['choices',0,'delta','content'], ['choices',0,'message','content'], ['data','choices',0,'delta','content'], ['data','choices',0,'message','content'], ['message','content'], ['delta','content'], ['data','content'], ['content'], ['answer'], ['output','text'], ['text']];
    for (const path of paths) {
        let cur = obj;
        for (const key of path) cur = cur == null ? undefined : cur[key];
        if (typeof cur === 'string' && cur) return cur;
    }
    for (const key of ['messages', 'contents', 'items', 'events', 'phases', 'data']) {
        const text = extractText(obj[key]);
        if (text) return text;
    }
    return '';
}

function parseQwenLine(line, state) {
    if (!line) return;
    const raw = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!raw || raw === '[DONE]' || raw === 'done') return;
    let obj;
    try { obj = JSON.parse(raw); } catch (_) {
        // قد تأتي رسالة RateLimited كنص خام غير JSON داخل البث
        if (looksRateLimited(raw)) state.rateLimited = true;
        return;
    }
    if (looksRateLimited(obj)) state.rateLimited = true;
    if (looksAuthError(obj)) state.authError = true;
    const created = obj?.['response.created'];
    if (created?.response_id) state.responseId = created.response_id;
    if (obj?.response_id) state.responseId = obj.response_id;
    state.text += extractText(obj);
}

async function askQwen(prompt, options = {}) {
    const context = options.context || {};
    const token = options.token || DEFAULT_TOKEN;
    const chatId = context.chatId || options.chatId || await createChat({ ...options, token });
    const parentId = context.parentMessageId || options.parentId || null;
    const model = options.model || DEFAULT_MODEL;
    const ts = Math.floor(Date.now() / 1000);
    const message = {
        id: null,
        fid: uuidv4(),
        chat_type: 't2t',
        content: prompt,
        role: 'user',
        feature_config: {
            thinking_enabled: Boolean(options.thinkingEnabled),
            output_schema: 'phase',
            research_mode: 'normal',
            auto_thinking: Boolean(options.thinkingEnabled),
            thinking_mode: options.thinkingEnabled ? 'Deep' : 'Fast',
            thinking_format: 'summary',
            auto_search: options.searchEnabled !== false
        },
        timestamp: ts,
        sub_chat_type: 't2t',
        models: [model],
        model: '',
        files: [],
        user_action: 'chat',
        extra: { meta: { subChatType: 't2t' } },
        parentId: parentId || null,
        parent_id: parentId || null
    };
    const payload = {
        stream: true,
        version: '2.1',
        incremental_output: true,
        chatId,
        chat_id: chatId,
        chat_mode: 'normal',
        model,
        messages: [message],
        timestamp: ts,
        parentId: parentId || '',
        parent_id: parentId || null
    };
    let response;
    try {
        response = await axios.post(`${BASE}/api/v2/chat/completions`, payload, {
            params: { chat_id: chatId }, headers: headers('chat', { ...options, token }), timeout: options.timeout || 500000, responseType: 'stream'
        });
    } catch (err) {
        classifyQwenAxiosError(err, 'Qwen chat completions failed');
    }
    const state = { text: '', responseId: null, rateLimited: false, authError: false };
    await new Promise((resolve, reject) => {
        response.data.on('data', chunk => chunk.toString().split('\n').forEach(line => parseQwenLine(line.trim(), state)));
        response.data.on('end', resolve);
        response.data.on('error', reject);
    });
    if (state.rateLimited) throw new QwenRateLimitedError('Qwen RateLimited أثناء التوليد');
    if (state.authError) throw new QwenAuthError('Qwen auth failed أثناء التوليد');
    if (!state.text.trim()) throw new Error('Qwen returned an empty response');
    if (options.context) {
        options.context.chatId = chatId;
        if (state.responseId) options.context.parentMessageId = state.responseId;
        options.context.lastUpdated = new Date();
    }
    return state.text;
}

module.exports = { askQwen, QwenRateLimitedError, QwenAuthError };
