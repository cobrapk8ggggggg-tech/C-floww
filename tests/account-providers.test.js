const { test, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const nock = require('../backend/node_modules/nock');
const { ChatGPTAndroid } = require('../backend/services/chatgptAndroid.service');
const { askDeepSeekWorker } = require('../backend/services/deepseekWorker.service');
const { callAccountProvider } = require('../backend/services/accountProviders.service');
const { normalizeAccountSettings, isChatGPTProvider, isDeepSeekWorkerProvider, withConversationLock } = require('../backend/services/accountSettings.service');
const { askGeminiWeb, uploadGeminiAttachment } = require('../backend/services/geminiWeb.service');
const Settings = require('../backend/models/settings.model');
const BASE = 'https://android.chat.openai.com';
before(() => nock.disableNetConnect());
afterEach(() => { assert.deepEqual(nock.pendingMocks(), []); nock.cleanAll(); });
function response(text = 'ترجمة كاملة.', cid = 'new-cid') {
    return 'data: ' + JSON.stringify({ conversation_id: cid, message: { id: 'm-final', author: { role: 'assistant' }, channel: 'final',
        content: { parts: [text] }, status: 'finished_successfully', end_turn: true } }) + '\n\ndata: [DONE]\n\n';
}
function byteStream(s) { return Readable.from([...Buffer.from(s)].map(b => Buffer.from([b]))); }
function gemFrame(text) {
    return JSON.stringify([['wrb.fr', null, JSON.stringify([null, ['conv', 'r2'], null, {}, [['choice', [text]]]])]]) + '\n';
}
test('ChatGPT creates a conversation in selected project and sends model/thinking settings', async () => {
    nock(BASE).post('/backend-api/conversation', q => {
        assert.equal(q.model, 'gpt-test'); assert.equal(q.thinking_effort, 'extended');
        assert.equal(q.conversation_mode.gizmo_id, 'project-1'); assert.equal(q.messages[0].metadata.gizmo_id, 'project-1');
        assert.equal(q.messages[0].content.parts[0], 'Translate'); assert.ok(!q.conversation_id); return true;
    }).reply(200, () => byteStream(response()));
    const context = {};
    assert.equal(await new ChatGPTAndroid('session-token', 'account').send('Translate', { context, projectId: 'project-1', model: 'gpt-test', reasoningEffort: 'extended' }), 'ترجمة كاملة.');
    assert.equal(context.conversationId, 'new-cid'); assert.equal(context.parentMessageId, 'm-final');
});
test('ChatGPT fetches current parent for existing project conversation', async () => {
    nock(BASE).get('/backend-api/conversation/existing').reply(200, { current_node: 'latest-node', gizmo_id: 'project-1' });
    nock(BASE).post('/backend-api/conversation', q => q.conversation_id === 'existing' && q.parent_message_id === 'latest-node').reply(200, response('تم.', 'existing'));
    await new ChatGPTAndroid('t', 'a').send('p', { context: { conversationId: 'existing', parentMessageId: 'stale' }, projectId: 'project-1' });
});
test('ChatGPT rejects mismatched project before sending', async () => {
    nock(BASE).get('/backend-api/conversation/existing').reply(200, { current_node: 'n', gizmo_id: 'other-project' });
    await assert.rejects(new ChatGPTAndroid('t', 'a').send('p', { conversationId: 'existing', projectId: 'selected' }), /another project/);
});
test('ChatGPT ignores reasoning channel and returns only final answer', async () => {
    const thinking = 'data: ' + JSON.stringify({ message: { author: { role: 'assistant' }, channel: 'analysis', content: { parts: ['private reasoning'] } } }) + '\n\n';
    nock(BASE).post('/backend-api/conversation').reply(200, () => byteStream(thinking + response('الجواب.')));
    assert.equal(await new ChatGPTAndroid('t', 'a').send('p'), 'الجواب.');
});
test('ChatGPT reports stream application errors', async () => {
    nock(BASE).post('/backend-api/conversation').reply(200, 'data: {"error":{"code":"quota"}}\n\n');
    await assert.rejects(new ChatGPTAndroid('t', 'a').send('p'), /reported an error/);
});
test('ChatGPT rejects disconnected partial completion', async () => {
    const partial = response().replace('finished_successfully', 'in_progress').replace('"end_turn":true', '"end_turn":false');
    nock(BASE).post('/backend-api/conversation').reply(200, partial);
    await assert.rejects(new ChatGPTAndroid('t', 'a').send('p'), /before completion/);
});
test('ChatGPT does not retry conversation POST on upstream 500', async () => {
    nock(BASE).post('/backend-api/conversation').reply(500, {});
    await assert.rejects(new ChatGPTAndroid('t', 'a').send('p'));
});
test('ChatGPT lists models, projects and paginated chats with account headers', async () => {
    nock(BASE, { reqheaders: { authorization: 'Bearer t', 'chatgpt-account-id': 'a' } })
        .get('/backend-api/models').reply(200, { models: [{ slug: 'auto' }] })
        .get('/backend-api/gizmos/snorlax/sidebar').query(q => q.cursor === 'next' && q.conversations_per_gizmo === '5').reply(200, { items: [{ gizmo: { gizmo: { id: 'p', display: { name: 'Project' } } }, conversations: { items: [{ id: 'c' }] } }], cursor: 'next2' })
        .get('/backend-api/conversations').query(q => q.offset === '50' && q.limit === '50').reply(200, { items: [{ id: 'c' }] });
    const api = new ChatGPTAndroid('t', 'a');
    assert.equal((await api.models())[0].slug, 'auto');
    assert.equal((await api.projects('next')).items[0].chats[0].id, 'c');
    assert.equal((await api.chats(50)).items[0].id, 'c');
});
test('ChatGPT extracts account ID from JWT claims without logging token', () => {
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-jwt' } })).toString('base64url');
    assert.equal(new ChatGPTAndroid('x.' + payload + '.x').http.defaults.headers['ChatGPT-Account-ID'], 'account-jwt');
    assert.equal(new ChatGPTAndroid('opaque-session').http.defaults.headers['ChatGPT-Account-ID'], undefined);
});
test('ChatGPT uploads a file without forwarding account credentials to storage', async () => {
    nock(BASE).post('/backend-api/files', q => q.file_name === 'chapter.txt' && q.file_size === 5).reply(200, { file_id: 'file1', upload_url: 'https://storage.example/upload' });
    nock('https://storage.example', { badheaders: ['authorization', 'chatgpt-account-id'] }).put('/upload', 'hello').reply(201);
    nock(BASE).post('/backend-api/files/file1/uploaded', {}).reply(200, {});
    const uploaded = await new ChatGPTAndroid('t', 'a').upload({ buffer: Buffer.from('hello'), originalname: 'chapter.txt', mimetype: 'text/plain' });
    assert.equal(uploaded.attachment.id, 'file1'); assert.equal(uploaded.part, undefined);
});
test('ChatGPT submits uploaded image and file metadata', async () => {
    const item = { part: { content_type: 'image_asset_pointer', asset_pointer: 'file-service://f' }, attachment: { id: 'f', name: 'x.png' } };
    nock(BASE).post('/backend-api/conversation', q => q.messages[0].content.content_type === 'multimodal_text' && q.messages[0].metadata.attachments[0].id === 'f').reply(200, response());
    await new ChatGPTAndroid('t', 'a').send('Look', { attachments: [item] });
});
test('Gemini account index/model/context and attachments match supplied protocol', async () => {
    nock('https://gemini.google.com').get('/u/0/app').reply(200, '"SNlM0e":"csrf","FdrFJe":"123"');
    nock('https://gemini.google.com', { reqheaders: { 'x-goog-ext-525001261-jspb': '["custom-model"]' } })
        .post('/u/0/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate', body => {
            const params = typeof body === 'string' ? new URLSearchParams(body) : body;
            const payload = JSON.parse(JSON.parse(params.get ? params.get('f.req') : params['f.req'])[1]);
            assert.equal(payload[2][0], 'conv'); assert.equal(payload[2][1], 'r1');
            assert.equal(payload[0][3][0][0][0], 'uploaded-uri'); return true;
        }).query(true).reply(200, () => byteStream(gemFrame('رد نهائي.')));
    const context = { geminiConv: { conversation_id: 'conv', response_id: 'r1', choice_id: 'old' } };
    const result = await askGeminiWeb('p', { token: '__Secure-1PSID=fake-index0', accountIndex: 0,
        modelHeader: '["custom-model"]', context, autoContinue: false, attachments: [{ uri: 'uploaded-uri', name: 'a.txt' }] });
    assert.equal(result, 'رد نهائي.'); assert.equal(context.geminiConv.response_id, 'r2');
});
test('Gemini upload uses resumable protocol and returns a real server URI', async () => {
    nock('https://push.clients6.google.com').post('/upload/').reply(200, '', { 'X-Goog-Upload-Url': 'https://push.clients6.google.com/finalize' });
    nock('https://push.clients6.google.com', { reqheaders: { 'x-goog-upload-command': 'upload, finalize' } }).post('/finalize', 'abc').reply(200, 'real-uri');
    const result = await uploadGeminiAttachment('__Secure-1PSID=upload-account', { buffer: Buffer.from('abc'), originalname: 'a.txt', mimetype: 'text/plain' });
    assert.equal(result.uri, 'real-uri');
});
test('DeepSeek Worker forwards flags, sampling and session parent, preserving zero values', async () => {
    nock('https://deepseek-pow.contact-3mh.workers.dev').post('/api/chat', q => {
        assert.equal(q.token, 'ds'); assert.equal(q.session_id, 'session'); assert.equal(q.parent_message_id, 'parent');
        assert.equal(q.temperature, 0); assert.equal(q.max_tokens, 30000); assert.equal(q.thinking_enabled, true); assert.equal(q.search_enabled, false); return true;
    }).reply(200, { response: 'جواب.', session_id: 'session', parent_message_id: 'next', thinking: 'not output' });
    const context = { sessionId: 'session', parentMessageId: 'parent' };
    assert.equal(await askDeepSeekWorker('p', { token: 'ds', context, temperature: 0, maxTokens: 30000, thinkingEnabled: true }), 'جواب.');
    assert.equal(context.parentMessageId, 'next');
});
test('DeepSeek Worker requires own token', async () => await assert.rejects(askDeepSeekWorker('p'), /requires/));
for (const [name, data] of [['application error', { error: 'auth' }], ['empty response', { response: '' }], ['token limit', { response: 'جزء', finish_reason: 'length' }]]) {
    test('DeepSeek Worker rejects ' + name, async () => {
        nock('https://deepseek-pow.contact-3mh.workers.dev').post('/api/chat').reply(200, data);
        await assert.rejects(askDeepSeekWorker('p', { token: 'ds' }));
    });
}
function memoryStore() { const map = new Map(); return { get: async k => structuredClone(map.get(k)), set: async (k, v) => map.set(k, structuredClone(v)), map }; }
test('Per-job chats persist across calls and keep purposes/accounts/jobs separate', async () => {
    const store = memoryStore(); let counter = 0; const seen = [];
    const api = { send: async (p, o) => { seen.push(o.context.conversationId); o.context.conversationId ||= 'c' + ++counter; return 'رد.'; } };
    const provider = { providerId: 'chatgpt_1', taskConversations: {} };
    const call = (purpose, job = 'job1', token = 't') => callAccountProvider(provider, 'auto', token, 'p', {
        conversationPurpose: purpose, deepSeekJobId: job, stateStore: store, chatgptClient: api });
    await call('chapters'); await call('chapters'); await call('glossary'); await call('review'); await call('chapters', 'job2'); await call('chapters', 'job1', 'another-token');
    assert.deepEqual(seen, [undefined, 'c1', undefined, undefined, undefined, undefined]); assert.equal(store.map.size, 5);
});
test('Changing selected conversation starts with new IDs, and project choice reaches send', async () => {
    const store = memoryStore(); const seen = [];
    const api = { send: async (p, o) => { seen.push([o.context.conversationId, o.projectId, o.model]); return 'تم.'; } };
    const provider = { providerId: 'chatgpt_1', taskConversations: { translation: { mode: 'reuse', conversationId: 'chosen1', projectId: 'proj', model: 'task-model' } } };
    await callAccountProvider(provider, 'auto', 't', 'p', { stateStore: store, chatgptClient: api });
    provider.taskConversations.translation.conversationId = 'chosen2';
    await callAccountProvider(provider, 'auto', 't', 'p', { stateStore: store, chatgptClient: api });
    assert.deepEqual(seen, [['chosen1', 'proj', 'task-model'], ['chosen2', 'proj', 'task-model']]);
});
test('New conversation mode does not reuse stored state', async () => {
    const store = memoryStore(); const provider = { providerId: 'chatgpt_x', taskConversations: { translation: { mode: 'new' } } };
    const api = { send: async (p, o) => { assert.equal(o.context.conversationId, undefined); o.context.conversationId = 'new'; return 'رد.'; } };
    for (let i = 0; i < 2; i++) await callAccountProvider(provider, 'auto', 't', 'p', { deepSeekJobId: 'j', stateStore: store, chatgptClient: api });
    assert.equal(store.map.size, 0);
});
test('Locks serialize shared conversation writes and recover from failures', async () => {
    const events = [];
    await Promise.allSettled([
        withConversationLock('same', async () => { events.push('a-start'); await new Promise(r => setTimeout(r, 5)); events.push('a-end'); throw new Error('failed'); }),
        withConversationLock('same', async () => { events.push('b'); })
    ]);
    assert.deepEqual(events, ['a-start', 'a-end', 'b']);
});
test('Account schema round-trips settings and normalization clamps numeric ranges', () => {
    const normalized = normalizeAccountSettings({ geminiAccountIndex: 0, temperature: 0, maxTokens: 999999, taskConversations: {
        translation: { mode: 'reuse', projectId: 'p', conversationId: 'c', model: 'gpt-test', reasoningEffort: 'extended' },
        glossary: { mode: 'new' }, review: { mode: 'per_job' } } });
    const model = new Settings({ translationProviders: [{ providerId: 'chatgpt_1', name: 'GPT', ...normalized }] });
    const roundTrip = JSON.parse(JSON.stringify(model)).translationProviders[0];
    assert.equal(roundTrip.taskConversations.translation.projectId, 'p'); assert.equal(roundTrip.taskConversations.translation.conversationId, 'c');
    assert.equal(roundTrip.temperature, 0); assert.equal(roundTrip.geminiAccountIndex, 0); assert.equal(roundTrip.maxTokens, 131072);
});
test('Reuse mode cannot silently create a conversation when ID is missing', () => {
    assert.throws(() => normalizeAccountSettings({ taskConversations: { review: { mode: 'reuse' } } }), /اختر محادثة/);
});
test('Custom models named GPT or DeepSeek do not hijack provider classification', () => {
    assert.equal(isChatGPTProvider({ providerId: 'custom', name: 'ChatGPT', selectedModel: 'gpt-test' }), false);
    assert.equal(isDeepSeekWorkerProvider({ providerId: 'custom', selectedModel: 'deepseek-chat' }), false);
    assert.equal(isDeepSeekWorkerProvider({ providerId: 'deepseek_worker_1' }), true);
});

test('Opaque ChatGPT token discovers account without a manually entered ID', async () => {
    nock(BASE, { reqheaders: { authorization: 'Bearer opaque' }, badheaders: ['chatgpt-account-id'] })
        .get('/backend-api/accounts/check/v4-2023-04-27').reply(200, { default_account_id: 'discovered', accounts: { discovered: {} } });
    nock(BASE, { reqheaders: { 'chatgpt-account-id': 'discovered' } }).get('/backend-api/models').reply(200, { models: [{ slug: 'auto' }] });
    assert.equal((await new ChatGPTAndroid('Bearer opaque').models())[0].slug, 'auto');
});
test('Project chat listing requests the project endpoint, not the limited sidebar preview', async () => {
    nock(BASE).get('/backend-api/gizmos/project%2Fsafe/conversations').query({ limit: 50, cursor: 'page2' }).reply(200, { items: [{ id: 'sixth-chat' }], next_cursor: 'page3' });
    assert.equal((await new ChatGPTAndroid('t', 'a').projectChats('project/safe', 'page2')).items[0].id, 'sixth-chat');
});

test('ChatGPT always receives the untouched complete chapter in one request, even if paragraph mode was saved true', async () => {
    const source = 'A long paragraph from a novel. '.repeat(250) + '\n\nThe final paragraph.';
    const prompt = 'Translate the entire chapter:\n' + source;
    const sent = [];
    const chatgptClient = { send: async input => { sent.push(input); return 'الفصل كاملًا.'; } };
    assert.equal(await callAccountProvider({ providerId: 'chatgpt_test', geminiParagraphMode: true, translationChunkChars: 500 }, 'auto', 'token', prompt,
        { conversationPurpose: 'chapters', sourceText: source, chatgptClient }), 'الفصل كاملًا.');
    assert.deepEqual(sent, [prompt]);
});
test('DeepSeek Worker receives the full chapter without paragraph markers', async () => {
    const source = 'A detailed novel paragraph. '.repeat(220);
    const prompt = 'Translate:\n' + source;
    nock('https://deepseek-pow.contact-3mh.workers.dev').post('/api/chat', body => body.prompt === prompt)
        .reply(200, { response: 'ترجمة الفصل.' });
    assert.equal(await callAccountProvider({ providerId: 'deepseek_worker_test', geminiParagraphMode: true }, 'deepseek-chat', 'token', prompt,
        { conversationPurpose: 'chapters', sourceText: source }), 'ترجمة الفصل.');
});
for (const enabled of [undefined, true, false]) test(`Gemini paragraph mode ${enabled === undefined ? 'defaults on' : enabled ? 'on' : 'off'} follows saved provider preference`, async () => {
    const source = ['An event in the novel. '.repeat(35), 'The final event. '.repeat(35)].join('\n\n');
    const prompt = 'Translate fully:\n' + source;
    const sent = [];
    nock('https://gemini.google.com').persist().get('/u/1/app').reply(200, '"SNlM0e":"csrf","FdrFJe":"-123"');
    nock('https://gemini.google.com').persist().post('/u/1/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate').query(true).reply((uri, body) => {
        const form = typeof body === 'string' ? new URLSearchParams(body) : body;
        const request = JSON.parse(JSON.parse(form.get ? form.get('f.req') : form['f.req'])[1])[0][0];
        sent.push(request);
        let answer = 'ترجمة الفصل كاملًا.';
        if (enabled !== false) {
            const nonce = request.match(/\[\[END_([a-f0-9]+)\]\]/)[1];
            const ids = [...request.matchAll(new RegExp(`\\[\\[${nonce}_(\\d{6})\\]\\]`, 'g'))];
            answer = ids.map(m => `${m[0]}\n${'ترجمة عربية مفصلة لجميع أحداث هذه الفقرة دون اختصار. '.repeat(30)}`).join('\n') + `\n[[END_${nonce}]]`;
        }
        return [200, gemFrame(answer)];
    });
    const provider = { providerId: 'gemini_web_test', translationChunkChars: 500, ...(enabled === undefined ? {} : { geminiParagraphMode: enabled }) };
    const result = await callAccountProvider(provider, 'adaptive', '__Secure-1PSID=paragraph-mode-test', prompt,
        { conversationPurpose: 'chapters', sourceText: source });
    if (enabled === false) assert.deepEqual(sent, [prompt]);
    else { assert.ok(sent.length > 1); assert.ok(sent.every(p => p.includes('[[END_'))); assert.ok(!result.includes('[[END_')); }
});
test('Paragraph mode normalizes false without replacing it and is ignored for other providers', () => {
    assert.equal(normalizeAccountSettings({ providerId: 'gemini_web_1' }).geminiParagraphMode, true);
    assert.equal(normalizeAccountSettings({ providerId: 'gemini_web_1', geminiParagraphMode: false }).geminiParagraphMode, false);
    assert.equal(normalizeAccountSettings({ providerId: 'chatgpt_1', geminiParagraphMode: true }).geminiParagraphMode, false);
});
