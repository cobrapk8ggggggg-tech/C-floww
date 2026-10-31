const axios = require('axios');
const DEFAULT_WORKER_URL = 'https://deepseek-pow.contact-3mh.workers.dev';
function workerBase(url = DEFAULT_WORKER_URL) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('DeepSeek Worker URL must use HTTPS');
    return url.replace(/\/+$/, '').replace(/\/api\/chat$/, '');
}
async function askDeepSeekWorker(prompt, options = {}) {
    if (!options.token) throw new Error('DeepSeek Worker requires your DeepSeek account token');
    const context = options.context || {};
    const body = { token: String(options.token).trim().replace(/^Bearer\s+/i, ''), prompt, thinking_enabled: Boolean(options.thinkingEnabled),
        search_enabled: Boolean(options.searchEnabled), model: options.model || 'deepseek-chat',
        temperature: options.temperature ?? 0.7, max_tokens: options.maxTokens ?? 16384,
        presence_penalty: options.presencePenalty ?? 0, frequency_penalty: options.frequencyPenalty ?? 0,
        ...(context.sessionId ? { session_id: context.sessionId } : {}),
        ...(context.parentMessageId != null ? { parent_message_id: typeof context.parentMessageId === 'string' && /^\d+$/.test(context.parentMessageId) && Number.isSafeInteger(Number(context.parentMessageId)) ? Number(context.parentMessageId) : context.parentMessageId } : {}) };
    const { data } = await axios.post(workerBase(options.baseUrl || undefined) + '/api/chat', body, { timeout: options.timeout || 300000 });
    if (data.error || data.success === false) throw new Error('DeepSeek Worker rejected the request');
    if (typeof data.response !== 'string' || !data.response.trim()) throw new Error('DeepSeek Worker returned an empty answer');
    if (data.finish_reason === 'length') throw new Error('DeepSeek Worker output reached the token limit');
    context.sessionId = data.session_id || context.sessionId;
    context.parentMessageId = data.parent_message_id ?? context.parentMessageId;
    return data.response;
}
module.exports = { askDeepSeekWorker, DEFAULT_WORKER_URL, workerBase };
async function workerCatalog(provider) {
    const token = String(provider.apiKeys[0]).replace(/^Bearer\s+/i, '').trim();
    const base = workerBase(provider.baseUrl || undefined);
    const [modelResult, chatResult] = await Promise.allSettled([
        axios.get(base + '/v1/models', { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }),
        axios.post(base + '/api/chat/sessions/list', { token }, { timeout: 30000 })
    ]);
    if (chatResult.status === 'rejected') throw chatResult.reason;
    const data = chatResult.value.data;
    if (data.success === false || data.error) throw new Error('DeepSeek account token was rejected');
    return { models: modelResult.status === 'fulfilled' ? (modelResult.value.data.data || []).map(m => ({ modelId: m.id, modelName: m.name || m.id })) : [],
        chats: (data.sessions || []).map(c => ({ id: c.id || c.session_id, title: c.title || 'محادثة DeepSeek',
            parentMessageId: c.last_response_id ?? c.last_message_id ?? c.parent_message_id })) };
}
module.exports.workerCatalog = workerCatalog;
