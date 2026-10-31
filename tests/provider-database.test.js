const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('../backend/node_modules/mongoose');
const { MongoMemoryServer } = require('../backend/node_modules/mongodb-memory-server');
const Settings = require('../backend/models/settings.model');
const Conversation = require('../backend/models/providerConversation.model');
const { callAccountProvider } = require('../backend/services/accountProviders.service');
const { normalizeProviderForStorage, callTranslationProvider } = require('../backend/routes/translatorRoutes')._ai;
const registerTranslator = require('../backend/routes/translatorRoutes');
const express = require('../backend/node_modules/express');
const nock = require('../backend/node_modules/nock');
let mongo, server, base;
before(async () => {
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
    await Conversation.init();
    const app = express(); app.use(express.json());
    const auth = (req, res, next) => req.headers.authorization === 'Bearer test-admin' ? next() : res.sendStatus(401);
    registerTranslator(app, auth, (req, res, next) => next());
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    nock.cleanAll(); if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect(); if (mongo) await mongo.stop();
});
test('HTTP settings save → real MongoDB → HTTP reload preserves every account field', async () => {
    const provider = { providerId: 'chatgpt_99', name: 'ChatGPT', apiKeys: ['test-session'], selectedModel: 'auto',
        chatgptAccountId: 'a', reasoningEffort: 'extended', translationChunkChars: 1800,
        taskConversations: { translation: { mode: 'reuse', projectId: 'p', conversationId: 'translation-chat', model: 'custom' },
            glossary: { mode: 'reuse', projectId: 'p', conversationId: 'glossary-chat' },
            review: { mode: 'reuse', projectId: 'p', conversationId: 'review-chat' } } };
    const saved = await fetch(base + '/api/translator/settings', { method: 'POST', headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ translationProviders: [provider] }) });
    assert.equal(saved.status, 200);
    const res = await fetch(base + '/api/translator/settings', { headers: { Authorization: 'Bearer test-admin' } });
    const actual = (await res.json()).translationProviders[0];
    assert.equal(actual.reasoningEffort, 'extended'); assert.equal(actual.translationChunkChars, 1800);
    assert.equal(actual.taskConversations.glossary.conversationId, 'glossary-chat');
    assert.equal(actual.taskConversations.review.conversationId, 'review-chat');
    assert.deepEqual(actual.apiKeys, ['test-session']);
});
test('Real MongoDB conversation state survives independent provider calls', async () => {
    const provider = { providerId: 'chatgpt_persist', taskConversations: { translation: { mode: 'per_job' } } };
    const seen = [];
    const api = { send: async (p, o) => { seen.push(o.context.conversationId); o.context.conversationId ||= 'persisted-remote-id'; return 'تم.'; } };
    await callAccountProvider(provider, 'auto', 'test-token', 'p', { deepSeekJobId: 'job', chatgptClient: api });
    await callAccountProvider(structuredClone(provider), 'auto', 'test-token', 'p', { deepSeekJobId: 'job', chatgptClient: api });
    assert.deepEqual(seen, [undefined, 'persisted-remote-id']);
    const row = await Conversation.findOne().lean(); assert.ok(row.expiresAt > new Date()); assert.ok(!row.key.includes('test-token'));
});
test('Unified caller accepts a Mongoose provider subdocument with Map task settings', async () => {
    const data = await Settings.findOne(); const provider = data.translationProviders[0];
    nock('https://android.chat.openai.com').get('/backend-api/accounts/check/v4-2023-04-27').reply(200, { default_account_id: 'a' });
    nock('https://android.chat.openai.com').get('/backend-api/conversation/translation-chat').reply(200, { current_node: 'n', gizmo_id: 'p' });
    nock('https://android.chat.openai.com').post('/backend-api/conversation', body => body.model === 'custom' && body.conversation_mode.gizmo_id === 'p')
        .reply(200, 'data: ' + JSON.stringify({ conversation_id: 'translation-chat', message: { id: 'm', author: { role: 'assistant' }, status: 'finished_successfully', content: { parts: ['تم.'] } } }) + '\n\n');
    assert.equal(await callTranslationProvider(provider, 'auto', 'test-session', 'p', { conversationPurpose: 'chapters' }), 'تم.');
    assert.deepEqual(nock.pendingMocks(), []);
});
test('Normalization preserves cookie headers and custom provider independence in MongoDB', async () => {
    const providers = [
        { providerId: 'gemini_web_1', name: 'Gemini', apiKeys: ['__Secure-1PSID=fake; __Secure-1PSIDTS=fake-ts'], geminiAccountIndex: 0, geminiModelHeader: '[1]', geminiBuildLabel: 'build', allowGuestFallback: false, taskConversations: { review: { mode: 'reuse', conversationId: 'gem-c', responseId: 'r', choiceId: 'choice' } } },
        { providerId: 'custom', name: 'ChatGPT DeepSeek', baseUrl: 'https://custom.example/v1', apiKeys: ['sk-custom'], deepSeekTokens: ['wrong-token'], qwenTokens: ['wrong-token'], selectedModel: 'gpt-foo' },
        { providerId: 'deepseek_worker_1', name: 'Worker', apiKeys: ['ds-token'], baseUrl: 'https://deepseek-pow.contact-3mh.workers.dev', thinkingEnabled: true, temperature: 0, maxTokens: 30000 }
    ].map(normalizeProviderForStorage);
    const data = await Settings.create({ translationProviders: providers });
    const actual = (await Settings.findById(data.id)).toObject({ flattenMaps: true }).translationProviders;
    assert.equal(actual[0].geminiAccountIndex, 0); assert.equal(actual[0].taskConversations.review.responseId, 'r');
    assert.ok(actual[0].apiKeys[0].includes('; __Secure-1PSIDTS=')); assert.equal(actual[1].baseUrl, 'https://custom.example/v1');
    assert.deepEqual(actual[1].deepSeekTokens, []); assert.deepEqual(actual[1].qwenTokens, []);
    assert.equal(actual[2].temperature, 0); assert.equal(actual[2].thinkingEnabled, true);
});
test('Gemini paragraph mode can be switched off and on through the real settings API and MongoDB', async () => {
    for (const enabled of [false, true, false]) {
        const res = await fetch(base + '/api/translator/settings', { method: 'POST', headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' },
            body: JSON.stringify({ translationProviders: [{ providerId: 'gemini_web_toggle', name: 'Gemini', apiKeys: ['fake-cookie'], geminiParagraphMode: enabled }] }) });
        assert.equal(res.status, 200);
        const saved = await (await fetch(base + '/api/translator/settings', { headers: { Authorization: 'Bearer test-admin' } })).json();
        assert.equal(saved.translationProviders[0].geminiParagraphMode, enabled);
    }
});
