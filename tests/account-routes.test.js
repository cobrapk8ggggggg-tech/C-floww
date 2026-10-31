const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('../backend/node_modules/express');
const multer = require('../backend/node_modules/multer');
const register = require('../backend/routes/accountProviderRoutes');
let server, base;
const calls = [];
const provider = { providerId: 'chatgpt_1', apiKeys: ['private-token'], chatgptAccountId: 'a', selectedModel: 'auto', taskConversations: {
    translation: { projectId: 'project', conversationId: 'old-cid' } } };
const client = () => ({ models: async () => [{ slug: 'auto', title: 'Automatic' }],
    projects: async () => ({ items: [{ id: 'project', name: 'Project', chats: [{ id: 'c' }] }] }),
    projectChats: async id => ({ items: [{ id: id + '-chat', title: 'Inside project' }] }),
    chats: async offset => ({ items: [{ id: String(offset) }] }),
    conversation: async id => ({ current_node: 'n', gizmo_id: 'project', title: id }),
    upload: async file => ({ attachment: { id: 'f', name: file.originalname, size: file.buffer.length } }),
    send: async (prompt, options) => { calls.push(options); options.context.conversationId = options.context.conversationId || 'new-cid'; options.context.parentMessageId = 'node'; return 'رد عربي.'; }
});
before(async () => {
    const app = express(); app.use(express.json());
    register(app,
        (req, res, next) => req.headers.authorization ? next() : res.status(401).json({ message: 'No token' }),
        (req, res, next) => req.headers.authorization === 'Bearer admin' ? next() : res.status(403).json({ message: 'Admin required' }),
        multer({ limits: { fileSize: 1024 } }), { client, stateStore: { set: async () => {} } });
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/translator/accounts/`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });
async function post(action, body = {}, auth = 'Bearer admin') {
    return fetch(base + action, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify({ provider, ...body }) });
}
test('Account operations require authentication', async () => assert.equal((await post('models', {}, '')).status, 401));
test('Account operations require admin middleware', async () => assert.equal((await post('models', {}, 'Bearer user')).status, 403));
test('Account model browsing returns selectable model IDs', async () => {
    const res = await post('models'); assert.equal(res.status, 200); assert.deepEqual((await res.json()).models, [{ modelId: 'auto', modelName: 'Automatic' }]);
});
test('Projects and project chats are available to UI', async () => {
    const res = await post('projects'); assert.equal((await res.json()).items[0].chats[0].id, 'c');
});
test('Chat listing forwards offset', async () => {
    assert.equal((await (await post('chats', { offset: 50 })).json()).items[0].id, '50');
});
test('Conversation inspection returns project without private session fields', async () => {
    const data = await (await post('conversation', { conversationId: 'c' })).json(); assert.equal(data.projectId, 'project');
    assert.ok(!JSON.stringify(data).includes('private-token'));
});
test('UI can create project conversation and capture ID for task settings', async () => {
    const data = await (await post('send', { prompt: 'Hello', purpose: 'translation', createNew: true })).json();
    assert.equal(data.context.conversationId, 'new-cid'); assert.equal(calls.at(-1).projectId, 'project');
    assert.equal(data.reply, 'رد عربي.'); assert.ok(!JSON.stringify(data).includes('private-token'));
});
test('UI can reuse chosen conversation', async () => {
    const data = await (await post('send', { prompt: 'Hello', purpose: 'translation' })).json(); assert.equal(data.context.conversationId, 'old-cid');
});
test('Empty prompt is rejected before provider invocation', async () => assert.equal((await post('send', { prompt: '' })).status, 400));
test('Unsupported provider cannot be routed through account endpoints', async () => assert.equal((await post('models', { provider: { providerId: 'custom', apiKeys: ['t'] } })).status, 400));
test('Native multipart upload reaches client with exact bytes', async () => {
    const form = new FormData(); form.append('provider', JSON.stringify(provider)); form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'chapter.txt');
    const res = await fetch(base + 'upload', { method: 'POST', headers: { Authorization: 'Bearer admin' }, body: form });
    const data = await res.json(); assert.equal(res.status, 200); assert.equal(data.attachment.attachment.name, 'chapter.txt'); assert.equal(data.attachment.attachment.size, 5);
});
test('Provider error sanitization does not expose Axios credential config', () => {
    assert.equal(register.safeError({ isAxiosError: true, response: { status: 403 }, config: { headers: { Authorization: 'private' } } }).includes('بيانات الحساب'), true);
});

test('Oversized attachments return an explicit 413 response', async () => {
    const form = new FormData(); form.append('provider', JSON.stringify(provider)); form.append('file', new Blob(['x'.repeat(2048)]), 'large.txt');
    const res = await fetch(base + 'upload', { method: 'POST', headers: { Authorization: 'Bearer admin' }, body: form });
    assert.equal(res.status, 413); assert.ok((await res.json()).message);
});

test('Connect bundles account models, projects and chats without leaking credentials', async () => {
    const res = await post('connect'); const data = await res.json();
    assert.equal(res.status, 200); assert.equal(data.models[0].modelId, 'auto');
    assert.equal(data.projects.items[0].id, 'project'); assert.equal(data.capabilities.projects, true);
    assert.equal(JSON.stringify(data).includes('private-token'), false);
});
test('Selecting a project fetches its own chat list', async () => {
    const res = await post('project-chats', { projectId: 'project' });
    assert.equal((await res.json()).items[0].id, 'project-chat');
});
test('One-click creation needs no manually typed prompt', async () => {
    const res = await post('send', { createNew: true, purpose: 'glossary' });
    assert.equal(res.status, 200); assert.equal((await res.json()).context.conversationId, 'new-cid');
});
