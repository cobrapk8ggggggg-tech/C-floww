const { ChatGPTAndroid } = require('./chatgptAndroid.service');
const { askGeminiWeb } = require('./geminiWeb.service');
const { askDeepSeekWorker } = require('./deepseekWorker.service');
const { translateComplete } = require('./completeTranslation.service');
const { isChatGPTProvider, isDeepSeekWorkerProvider, taskPurpose, withConversationLock, accountScope, selectedConversationKey } = require('./accountSettings.service');
const Conversation = require('../models/providerConversation.model');
const defaultStore = {
    async get(key) { return (await Conversation.findOne({ key, expiresAt: { $gt: new Date() } }).lean())?.context; },
    async set(key, context) { await Conversation.updateOne({ key }, { $set: { context,
        expiresAt: new Date(Date.now() + 30 * 86400000) } }, { upsert: true }); }
};
async function callAccountProvider(provider, model, token, prompt, options = {}) {
    const purpose = taskPurpose(options.conversationPurpose);
    const task = provider.taskConversations?.[purpose] || {};
    const mode = task.mode || 'per_job';
    const scope = accountScope(provider, token);
    if (mode === 'reuse' && !task.conversationId) throw new Error('Selected conversation ID is required');
    const projectId = task.projectId || '';
    // The conversation ID is part of the key, so changing a selection cannot restore stale state.
    const selection = [task.conversationId || '', projectId].map(encodeURIComponent).join(':');
    const key = mode === 'reuse' ? selectedConversationKey(provider, token, task.conversationId, projectId) : `${scope}:${purpose}:${selection}:${options.deepSeekJobId || 'manual'}`;
    // Lock the actual remote conversation across purposes/jobs too.
    const lockKey = mode === 'reuse' ? `${scope}:${task.conversationId}` : key;
    return withConversationLock(lockKey, async () => {
        const store = options.stateStore || defaultStore;
        const persistent = mode !== 'new' && (mode === 'reuse' || Boolean(options.deepSeekJobId));
        let context = persistent ? await store.get(key) || {} : {};
        if (!Object.keys(context).length && mode === 'reuse') {
            context = isChatGPTProvider(provider) ? { conversationId: task.conversationId } : isDeepSeekWorkerProvider(provider)
                ? { sessionId: task.conversationId, parentMessageId: task.parentMessageId || null }
                : { geminiConv: { conversation_id: task.conversationId, response_id: task.responseId || '', choice_id: task.choiceId || '' } };
        }
        const send = async input => {
            const effectiveModel = task.model || model;
            let text;
            if (isChatGPTProvider(provider)) {
                const api = options.chatgptClient || new ChatGPTAndroid(token);
                text = await api.send(input, { context, projectId, model: effectiveModel,
                    reasoningEffort: task.reasoningEffort !== 'auto' && task.reasoningEffort || provider.reasoningEffort,
                    attachments: options.attachments, timeout: options.timeout });
            } else if (isDeepSeekWorkerProvider(provider)) {
                text = await askDeepSeekWorker(input, { token, context, baseUrl: provider.baseUrl || undefined,
                    model: effectiveModel, thinkingEnabled: provider.thinkingEnabled, searchEnabled: provider.searchEnabled,
                    temperature: provider.temperature, maxTokens: provider.maxTokens, presencePenalty: provider.presencePenalty,
                    frequencyPenalty: provider.frequencyPenalty, timeout: options.timeout });
            } else {
                const detected = effectiveModel && !['adaptive', 'gemini-web'].includes(effectiveModel)
                    ? await require('./geminiDiscovery.service').geminiOptions(token, effectiveModel, provider.geminiAccountIndex) : {};
                text = await askGeminiWeb(input, { token, context, timeout: options.timeout, log: options.log,
                    accountIndex: provider.geminiAccountIndex ?? 1, buildLabel: provider.geminiBuildLabel,
                    modelHeader: provider.geminiModelHeader, ...detected, allowGuestFallback: provider.allowGuestFallback === true,
                    autoContinue: false, attachments: options.attachments });
            }
            if (persistent) await store.set(key, context);
            return text;
        };
        if (/^gemini_web(?:_|$)/i.test(provider.providerId || '') && provider.geminiParagraphMode !== false && purpose === 'translation' && options.sourceText) {
            return translateComplete({ source: options.sourceText, prompt, send,
                chunkSize: provider.translationChunkChars || 2400, log: options.log });
        }
        return send(prompt);
    });
}
module.exports = { callAccountProvider, defaultStore };
