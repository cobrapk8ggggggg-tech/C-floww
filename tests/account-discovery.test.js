const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nock = require('../backend/node_modules/nock');
const { discoverGemini, geminiChats, geminiConversation, geminiOptions, parseRpc, modelsFromStatus } = require('../backend/services/geminiDiscovery.service');
const { workerCatalog } = require('../backend/services/deepseekWorker.service');
nock.disableNetConnect();
afterEach(() => { assert.deepEqual(nock.pendingMocks(), []); nock.cleanAll(); });
function frame(id, body) { return ")]}'\n\n100\n" + JSON.stringify([['wrb.fr', id, JSON.stringify(body)]]); }
function mockRpc(index, id, body) {
    return nock('https://gemini.google.com').post(`/u/${index}/_/BardChatUi/data/batchexecute`, data => {
        const form = new URLSearchParams(data); assert.equal(form.get('at'), 'csrf');
        return JSON.parse(form.get('f.req'))[0][0][0] === id;
    }).query(q => q.rpcids === id && q.bl === 'live-build').reply(200, frame(id, body));
}
function status() { const result = []; result[14] = 1000; const m = []; m[0] = 'account-model'; m[11] = 'Pro from account'; m[17] = 2; result[15] = [m]; result[16] = [16]; result[17] = []; return result; }
test('Gemini discovers account, models, named chats and latest continuation IDs without manual metadata', async () => {
    const token = '__Secure-1PSID=discovery-test';
    nock('https://gemini.google.com').get('/u/0/app').reply(200, '"SNlM0e":"csrf","FdrFJe":"-42","cfb2h":"live-build"');
    mockRpc(0, 'otAQ7b', status());
    const session = await discoverGemini(token); assert.equal(session.accountIndex, 0); assert.equal(session.models[0].modelName, 'Pro from account');
    mockRpc(0, 'MaZiqc', [null, null, [['cid', 'My novel', 1]]]);
    mockRpc(0, 'MaZiqc', [null, null, [['cid', 'My novel', 1], ['cid2', 'Terms', 0]]]);
    assert.equal((await geminiChats(token)).items.length, 2);
    const turn = []; turn[0] = ['cid', 'rid']; turn[3] = [[['rcid', ['answer']]]];
    mockRpc(0, 'hNvQHb', [[turn]]);
    assert.deepEqual(await geminiConversation(token, 'cid'), { id: 'cid', responseId: 'rid', choiceId: 'rcid' });
    const options = await geminiOptions(token, 'account-model');
    assert.equal(options.buildLabel, 'live-build'); assert.equal(JSON.parse(options.modelHeader)[4], 'account-model');
    await assert.rejects(geminiOptions(token, 'unavailable-model'), /unavailable/);
});
test('Gemini scans the next account when the first session is unauthenticated', async () => {
    const token = '__Secure-1PSID=second-account-test';
    for (const index of [0, 1]) nock('https://gemini.google.com').get(`/u/${index}/app`).reply(200, '"SNlM0e":"csrf","cfb2h":"live-build"');
    const unauthenticated = status(); unauthenticated[14] = 1016;
    mockRpc(0, 'otAQ7b', unauthenticated); const normalOmittedStatus = status(); normalOmittedStatus[14] = null; mockRpc(1, 'otAQ7b', normalOmittedStatus);
    assert.equal((await discoverGemini(token)).accountIndex, 1);
});
test('Gemini parser rejects missing RPC and malformed payloads rather than inventing account data', () => {
    assert.throws(() => parseRpc('100\n[]', 'otAQ7b'), /unsupported/);
    assert.deepEqual(modelsFromStatus([]), []);
});
test('Worker discovers models and named sessions with its account token', async () => {
    const base = 'https://deepseek-pow.contact-3mh.workers.dev';
    nock(base, { reqheaders: { authorization: 'Bearer worker-token' } }).get('/v1/models').reply(200, { data: [{ id: 'deepseek-chat' }] });
    nock(base).post('/api/chat/sessions/list', { token: 'worker-token' }).reply(200, { success: true, sessions: [{ id: 'session', title: 'Novel', last_response_id: 12 }] });
    const result = await workerCatalog({ apiKeys: ['Bearer worker-token'] });
    assert.equal(result.chats[0].title, 'Novel'); assert.equal(result.chats[0].parentMessageId, 12); assert.equal(result.models[0].modelId, 'deepseek-chat');
});
