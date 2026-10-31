const crypto = require('node:crypto');
const PURPOSES = ['translation', 'glossary', 'review', 'titles', 'metadata'];
function isChatGPTProvider(p) { return /^chatgpt(?:_|$)/i.test(p.providerId || ''); }
function isDeepSeekWorkerProvider(p) { return /^deepseek_worker(?:_|$)/i.test(p.providerId || ''); }
function taskPurpose(value) {
    return ({ chapters: 'translation', chapter_review: 'review', glossary: 'glossary' })[value] || (PURPOSES.includes(value) ? value : 'translation');
}
function normalizeAccountSettings(p) {
    const tasks = {};
    for (const purpose of PURPOSES) {
        const t = p.taskConversations?.[purpose] || {};
        tasks[purpose] = { mode: ['new', 'reuse', 'per_job'].includes(t.mode) ? t.mode : 'per_job',
            projectId: String(t.projectId || '').trim(), conversationId: String(t.conversationId || '').trim(),
            responseId: String(t.responseId || '').trim(), choiceId: String(t.choiceId || '').trim(),
            parentMessageId: t.parentMessageId == null ? '' : String(t.parentMessageId),
            model: String(t.model || '').trim(), reasoningEffort: String(t.reasoningEffort || 'auto') };
        if (tasks[purpose].mode === 'reuse' && !tasks[purpose].conversationId) throw new Error('اختر محادثة أو غيّر الوضع إلى محادثة جديدة: ' + purpose);
    }
    const number = (value, fallback, min, max) => Number.isFinite(+value) ? Math.min(max, Math.max(min, +value)) : fallback;
    return {
        chatgptAccountId: String(p.chatgptAccountId || '').trim(),
        reasoningEffort: String(p.reasoningEffort || 'auto'),
        geminiAccountIndex: Math.trunc(number(p.geminiAccountIndex ?? 1, 1, 0, 20)),
        geminiBuildLabel: String(p.geminiBuildLabel || '').trim(),
        geminiModelHeader: String(p.geminiModelHeader || '').trim(),
        allowGuestFallback: p.allowGuestFallback === true,
        temperature: number(p.temperature ?? 0.7, 0.7, 0, 2),
        maxTokens: Math.trunc(number(p.maxTokens ?? 16384, 16384, 256, 131072)),
        presencePenalty: number(p.presencePenalty ?? 0, 0, -2, 2),
        frequencyPenalty: number(p.frequencyPenalty ?? 0, 0, -2, 2),
        geminiParagraphMode: /^gemini_web(?:_|$)/i.test(p.providerId || '') && p.geminiParagraphMode !== false,
        translationChunkChars: Math.trunc(number(p.translationChunkChars ?? 2400, 2400, 500, 6000)),
        taskConversations: tasks
    };
}
// In-flight requests sharing an explicitly selected conversation must be serialized.
const queues = new Map();
async function withConversationLock(key, fn) {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    queues.set(key, next);
    try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
function accountScope(provider, token) {
    return `${provider.providerId}:${crypto.createHash('sha256').update(token || '').digest('hex')}`;
}
function selectedConversationKey(provider, token, conversationId, projectId = '') {
    return `${accountScope(provider, token)}:${[conversationId, projectId].map(encodeURIComponent).join(':')}:selected`;
}
module.exports = { selectedConversationKey, PURPOSES, isChatGPTProvider, isDeepSeekWorkerProvider, taskPurpose, normalizeAccountSettings, withConversationLock, accountScope };
