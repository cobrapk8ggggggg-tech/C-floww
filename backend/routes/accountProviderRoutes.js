const { defaultStore } = require('../services/accountProviders.service');
const { ChatGPTAndroid, selectableModel } = require('../services/chatgptAndroid.service');
const { askGeminiWeb, uploadGeminiAttachment } = require('../services/geminiWeb.service');
const { discoverGemini, geminiChats, geminiConversation, geminiOptions } = require('../services/geminiDiscovery.service');
const { workerCatalog, askDeepSeekWorker } = require('../services/deepseekWorker.service');
const { isChatGPTProvider, isDeepSeekWorkerProvider, withConversationLock, accountScope, selectedConversationKey } = require('../services/accountSettings.service');

function readProvider(req) {
    let provider = req.body?.provider;
    if (typeof provider === 'string') {
        try { provider = JSON.parse(provider); } catch (_) { throw new Error('Invalid provider configuration'); }
    }
    if (!provider || typeof provider !== 'object') throw new Error('Provider is required');
    if (!isChatGPTProvider(provider) && !isDeepSeekWorkerProvider(provider) && !/^gemini_web(?:_|$)/i.test(provider.providerId || '')) throw new Error('Unsupported account provider');
    if (!Array.isArray(provider.apiKeys) || !provider.apiKeys[0]) throw new Error('Account credentials are required');
    return provider;
}
function safeError(err) {
    // Axios messages/config can contain tokens, cookies and the entire prompt.
    const status = err.response?.status;
    if (/Gemini account is not authenticated/.test(err.message || '')) return 'تعذر دخول حساب Gemini. تأكد من صلاحية الكوكيز وإتاحة Gemini للحساب.';
    if (/تعذر اكتشاف حساب ChatGPT/.test(err.message || '')) return 'تعذر اكتشاف حساب ChatGPT. الصق توكن جلسة صالحًا وأعد الربط.';
    if (status === 422) return 'رفض المزوّد صيغة الطلب (422). حدّث الخادم وأعد ربط الحساب.';
    if (status === 401 || status === 403) return 'رفض المزوّد بيانات الحساب؛ الصق توكنًا أو كوكيز صالحة وأعد الربط.';
    return status ? `Provider HTTP ${status}` : err.isAxiosError ? 'Provider connection failed' :
        /token|cookie|credential|session|account|Invalid|Unsupported|required|conversation|project|empty|completion|stream|upload/i.test(err.message || '')
            ? String(err.message).slice(0, 180) : 'تعذر تنفيذ طلب المزوّد';
}
module.exports = function(app, verifyToken, verifyAdmin, upload, deps = {}) {
    const client = deps.client || (p => new ChatGPTAndroid(p.apiKeys[0]));
    const wrap = fn => async (req, res) => {
        try { await fn(req, res, readProvider(req)); }
        catch (err) { res.status(err.response?.status === 429 ? 429 : 400).json({ message: safeError(err) }); }
    };
    const prefix = '/api/translator/accounts';
    app.post(prefix + '/connect', verifyToken, verifyAdmin, wrap(async (req, res, p) => {
        if (isChatGPTProvider(p)) {
            const api = client(p);
            await api.ready?.();
            const [models, projects, chats] = await Promise.allSettled([api.models(), api.projects(), api.chats()]);
            if (models.status === 'rejected') throw models.reason;
            res.json({ profile: { name: 'ChatGPT' }, models: models.value.map(selectableModel),
                projects: projects.status === 'fulfilled' ? projects.value : { items: [] },
                chats: chats.status === 'fulfilled' ? chats.value : { items: [] },
                capabilities: { projects: true, chats: true, attachments: true },
                warnings: [projects.status === 'rejected' ? 'تعذر جلب المشاريع: ' + safeError(projects.reason) : '', chats.status === 'rejected' ? 'تعذر جلب المحادثات: ' + safeError(chats.reason) : ''].filter(Boolean) });
        } else if (isDeepSeekWorkerProvider(p)) {
            const data = await workerCatalog(p);
            res.json({ profile: { name: 'DeepSeek' }, models: data.models, chats: { items: data.chats }, projects: { items: [] },
                capabilities: { projects: false, chats: true, attachments: false } });
        } else {
            const session = await discoverGemini(p.apiKeys[0], undefined, true);
            const chats = await geminiChats(p.apiKeys[0], session.accountIndex);
            res.json({ profile: { name: 'Gemini' }, models: session.models.map(({ modelId, modelName }) => ({ modelId, modelName })),
                chats, projects: { items: [] }, detectedSettings: { geminiAccountIndex: session.accountIndex },
                capabilities: { projects: false, chats: true, attachments: true }, warnings: ['تعرض القائمة أحدث المحادثات؛ يمكنك طلب المزيد.'] });
        }
    }));
    app.post(prefix + '/project-chats', verifyToken, verifyAdmin, wrap(async (req, res, p) => {
        if (!isChatGPTProvider(p)) throw new Error('Projects are unavailable for this account provider');
        res.json(await client(p).projectChats(req.body.projectId, req.body.cursor));
    }));
    app.post(prefix + '/models', verifyToken, verifyAdmin, wrap(async (req, res, p) => {
        if (isDeepSeekWorkerProvider(p)) return res.json({ models: (await workerCatalog(p)).models });
        if (!isChatGPTProvider(p)) return res.json({ models: (await discoverGemini(p.apiKeys[0], p.geminiAccountIndex)).models.map(({ modelId, modelName }) => ({ modelId, modelName })) });
        res.json({ models: (await client(p).models()).map(selectableModel) });
    }));
    app.post(prefix + '/projects', verifyToken, verifyAdmin, wrap(async (req, res, p) => {
        if (!isChatGPTProvider(p)) throw new Error('Gemini project listing is not supported by the supplied client');
        res.json(await client(p).projects(req.body.cursor));
    }));
    app.post(prefix + '/chats', verifyToken, verifyAdmin, wrap(async (req, res, p) => {
        if (isDeepSeekWorkerProvider(p)) return res.json({ items: (await workerCatalog(p)).chats });
        if (!isChatGPTProvider(p)) return res.json(await geminiChats(p.apiKeys[0], p.geminiAccountIndex, req.body.limit));
        const offset = Math.max(0, Math.trunc(Number(req.body.offset) || 0));
        res.json(await client(p).chats(offset));
    }));
    app.post(prefix + '/conversation', verifyToken, verifyAdmin, wrap(async (req, res, p) => {
        if (!req.body.conversationId) throw new Error('A conversation is required');
        if (isDeepSeekWorkerProvider(p)) {
            const chat = (await workerCatalog(p)).chats.find(c => c.id === req.body.conversationId);
            if (!chat) throw new Error('Conversation is unavailable for this account');
            return res.json(chat);
        }
        if (!isChatGPTProvider(p)) return res.json(await geminiConversation(p.apiKeys[0], req.body.conversationId, p.geminiAccountIndex));
        const data = await client(p).conversation(req.body.conversationId);
        res.json({ id: req.body.conversationId, title: data.title, current_node: data.current_node,
            projectId: data.gizmo_id || data.conversation_mode?.gizmo_id || '' });
    }));
    app.post(prefix + '/upload', verifyToken, verifyAdmin, upload.single('file'), wrap(async (req, res, p) => {
        if (!req.file) throw new Error('A file is required');
        if (isDeepSeekWorkerProvider(p)) throw new Error('File uploads are unsupported by this account provider');
        const attachment = isChatGPTProvider(p) ? await client(p).upload(req.file) : await uploadGeminiAttachment(p.apiKeys[0], req.file);
        res.json({ attachment });
    }));
    app.post(prefix + '/send', verifyToken, verifyAdmin, wrap(async (req, res, p) => {
        const purpose = req.body.purpose || 'translation';
        const task = p.taskConversations?.[purpose] || {};
        const prompt = String(req.body.prompt || (req.body.createNew === true ? `أنت مساعد متخصص في مهمة ${purpose}. هذه محادثة مستقلة لهذه المهمة. أكّد استعدادك باختصار وانتظر النص.` : '')).trim();
        if (!prompt) throw new Error('A prompt is required');
        const create = req.body.createNew === true;
        const context = create ? {} : isDeepSeekWorkerProvider(p) ? { sessionId: task.conversationId || undefined, parentMessageId: task.parentMessageId === '' ? undefined : task.parentMessageId } : isChatGPTProvider(p) ? { conversationId: task.conversationId || undefined }
            : task.conversationId ? { geminiConv: { conversation_id: task.conversationId,
                response_id: task.responseId || '', choice_id: task.choiceId || '' } } : {};
        const attachments = Array.isArray(req.body.attachments) ? req.body.attachments.slice(0, 10) : [];
        const key = accountScope(p, p.apiKeys[0]) + ':' + (task.conversationId || 'new');
        const gemini = !isChatGPTProvider(p) && !isDeepSeekWorkerProvider(p);
        const detected = gemini ? await geminiOptions(p.apiKeys[0], task.model || p.selectedModel, p.geminiAccountIndex) : {};
        const reply = await withConversationLock(key, () => isChatGPTProvider(p)
            ? client(p).send(prompt, { context, projectId: task.projectId, model: task.model || p.selectedModel || 'auto',
                reasoningEffort: task.reasoningEffort === 'auto' ? p.reasoningEffort : task.reasoningEffort || p.reasoningEffort, attachments })
            : isDeepSeekWorkerProvider(p) ? askDeepSeekWorker(prompt, { token: p.apiKeys[0], context, baseUrl: p.baseUrl || undefined, model: task.model || p.selectedModel, thinkingEnabled: p.thinkingEnabled, searchEnabled: p.searchEnabled })
            : askGeminiWeb(prompt, { ...detected, token: p.apiKeys[0], context, attachments,
                allowGuestFallback: false, autoContinue: false }));
        // Session CSRF tokens and upstream credentials never leave the server.
        const publicContext = isDeepSeekWorkerProvider(p) ? { conversationId: context.sessionId, parentMessageId: context.parentMessageId } : isChatGPTProvider(p) ? { conversationId: context.conversationId, parentMessageId: context.parentMessageId }
            : { conversationId: context.geminiConv?.conversation_id, responseId: context.geminiConv?.response_id,
                choiceId: context.geminiConv?.choice_id };
        if (publicContext.conversationId) {
            await (deps.stateStore || defaultStore).set(selectedConversationKey(p, p.apiKeys[0], publicContext.conversationId, task.projectId || ''), context);
        }
        res.json({ reply, context: publicContext });
    }));
    app.use(prefix, (err, req, res, next) => {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'الحد الأقصى لحجم المرفق 10 MB' });
        if (err.name === 'MulterError') return res.status(400).json({ message: 'Invalid file upload' });
        next(err);
    });
};
module.exports.safeError = safeError;
