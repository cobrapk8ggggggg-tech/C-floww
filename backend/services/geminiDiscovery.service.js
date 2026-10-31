// Account discovery RPCs complement the supplied generation client. Protocol notes:
// https://github.com/HanaokaYuzu/Gemini-API (GetUserStatus/ListConversations/turns).
const axios = require('axios');
const crypto = require('node:crypto');
const { getJar, getTokens, geminiHeaders, cookiesToString, mergeSetCookies } = require('./geminiWeb.service');
const cache = new Map();
function key(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function parseRpc(text, id) {
    const found = [];
    function visit(value) {
        if (!Array.isArray(value)) return;
        if (value[0] === 'wrb.fr' && value[1] === id && typeof value[2] === 'string') {
            found.push(JSON.parse(value[2])); return;
        }
        for (const child of value) visit(child);
    }
    for (const line of String(text).split('\n')) {
        if (!line.trim().startsWith('[')) continue;
        try { visit(JSON.parse(line)); } catch (_) { /* Ignore framing, never execute upstream text. */ }
    }
    if (!found.length) throw new Error('Gemini account discovery returned an unsupported response');
    return found;
}
async function rpc(token, session, id, payload) {
    const jar = getJar(token);
    const response = await axios.post(`https://gemini.google.com/u/${session.accountIndex}/_/BardChatUi/data/batchexecute`,
        new URLSearchParams({ at: session.tokens.snlm0e, 'f.req': JSON.stringify([[[id, JSON.stringify(payload), null, 'generic']]]) }).toString(), {
            params: { rpcids: id, _reqid: crypto.randomInt(10000, 99999), 'source-path': `/u/${session.accountIndex}/app`, hl: 'en', rt: 'c',
                ...(session.tokens.buildLabel ? { bl: session.tokens.buildLabel } : {}), 'f.sid': session.tokens.fdrfje || '' },
            headers: { ...geminiHeaders(cookiesToString(jar.cookies)),
                'x-goog-ext-525001261-jspb': JSON.stringify([1, null, null, null, null, null, null, null, [4, 5, 6, 8], null, null, null, null, null, null, null, crypto.randomUUID()]),
                'x-goog-ext-73010989-jspb': '[0]', 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            timeout: 30000, maxRedirects: 0, responseType: 'text'
        });
    mergeSetCookies(jar, response.headers['set-cookie']);
    return parseRpc(response.data, id);
}
function modelsFromStatus(status) {
    const tiers = status[16] || [], flags = status[17] || [];
    const capacity = tiers.includes(21) ? 1 : tiers.includes(22) ? 2 : flags.includes(115) ? 4
        : tiers.includes(16) || flags.includes(106) ? 3 : tiers.includes(8) || flags.includes(19) ? 2 : 1;
    const field13 = tiers.includes(21) || tiers.includes(22);
    return (status[15] || []).filter(m => typeof m?.[0] === 'string').map(m => {
        const ordinal = Number.isInteger(m[17]) ? m[17] : Number.isInteger(m[9]) ? m[9] : 1;
        const header = [1, null, null, null, m[0], null, null, 0, [4, 5, 6, 8], null, null,
            ...(field13 ? [null, capacity] : [capacity]), null, null, ordinal];
        return { modelId: m[0], modelName: m[11] || m[19] || m[1] || 'Gemini', modelHeader: JSON.stringify(header) };
    });
}
async function discoverGemini(token, preferredIndex, refresh = false) {
    const id = key(token), old = cache.get(id);
    if (!refresh && old && old.expires > Date.now()) return old;
    const indexes = [...new Set([preferredIndex ?? 0, 0, 1, 2])];
    let lastError;
    for (const accountIndex of indexes) {
        try {
            const tokens = await getTokens(getJar(token), { accountIndex });
            if (!tokens) continue;
            const session = { accountIndex, tokens };
            const status = (await rpc(token, session, 'otAQ7b', []))[0];
            // GetUserStatus omits the status (null) on normal authorized sessions.
            if (!Array.isArray(status?.[15]) || (status[14] != null && status[14] !== 1000)) {
                throw new Error('Gemini account is not authenticated or requires Google account action');
            }
            const models = modelsFromStatus(status);
            const result = { ...session, models, expires: Date.now() + 10 * 60000 };
            if (cache.size >= 128) cache.delete(cache.keys().next().value);
            cache.set(id, result); return result;
        } catch (error) { lastError = error; }
    }
    throw lastError || new Error('Gemini account cookies are invalid or expired');
}
async function geminiChats(token, preferredIndex, limit = 50) {
    const session = await discoverGemini(token, preferredIndex);
    limit = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 50)));
    const items = new Map();
    for (const pinned of [1, 0]) {
        for (const body of await rpc(token, session, 'MaZiqc', [Math.min(200, limit), null, [pinned, null, 1]])) {
            for (const chat of body?.[2] || []) if (typeof chat?.[0] === 'string') items.set(chat[0], { id: chat[0], title: chat[1] || 'محادثة Gemini' });
        }
    }
    return { items: [...items.values()], limited: true, limit: Math.min(200, limit) };
}
async function geminiConversation(token, conversationId, preferredIndex) {
    const session = await discoverGemini(token, preferredIndex);
    const body = (await rpc(token, session, 'hNvQHb', [conversationId, 1, null, 1, [1], [4], null, 1]))[0];
    const turn = body?.[0]?.[0];
    const responseId = turn?.[0]?.[1], choiceId = turn?.[3]?.[0]?.[0]?.[0];
    if (!responseId || !choiceId) throw new Error('Gemini conversation continuation context is unavailable');
    return { id: conversationId, responseId, choiceId };
}
async function geminiOptions(token, model, preferredIndex) {
    const session = await discoverGemini(token, preferredIndex);
    const selected = session.models.find(m => m.modelId === model);
    if (model && !['adaptive', 'gemini-web'].includes(model) && !selected) throw new Error('Selected Gemini model is unavailable for this account');
    return { accountIndex: session.accountIndex, buildLabel: session.tokens.buildLabel,
        modelHeader: selected?.modelHeader || JSON.stringify([1, null, null, null, null, null, null, null, [4, 5, 6, 8], null, null, null, null, null, null, null]) };
}
module.exports = { discoverGemini, geminiChats, geminiConversation, geminiOptions, modelsFromStatus, parseRpc };
