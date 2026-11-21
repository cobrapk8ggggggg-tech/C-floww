// Opt-in, read-only account catalog test; never print tokens, titles or conversation IDs.
const fs = require('node:fs');
const { ChatGPTAndroid } = require('../backend/services/chatgptAndroid.service');
const { discoverGemini, geminiChats, geminiConversation } = require('../backend/services/geminiDiscovery.service');
const { workerCatalog } = require('../backend/services/deepseekWorker.service');
function cookieFile(file) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const value = raw.match(/^export BROWSER_COOKIE_HEADER=(['"])(.*?)\1\s*$/m);
    if (value) return value[2];
    if (/^export /m.test(raw)) throw new Error('Unsupported cookie file');
    return raw;
}
async function main() {
    const provider = process.env.LIVE_PROVIDER || 'gemini';
    const report = { date: new Date().toISOString(), provider, mode: 'read-only-account-catalog' };
    try {
        if (provider === 'gemini') {
            const token = process.env.GEMINI_COOKIE_HEADER || (process.env.GOOGLE_COOKIES_FILE && cookieFile(process.env.GOOGLE_COOKIES_FILE));
            if (!token) throw new Error('Credentials required');
            const session = await discoverGemini(token);
            const chats = await geminiChats(token, session.accountIndex);
            report.modelCount = session.models.length; report.chatCount = chats.items.length;
            if (chats.items[0]) report.continuationDiscovered = Boolean((await geminiConversation(token, chats.items[0].id, session.accountIndex)).choiceId);
        } else if (provider === 'chatgpt') {
            const api = new ChatGPTAndroid(process.env.CHATGPT_ACCESS_TOKEN);
            report.modelCount = (await api.models()).length;
            const projects = await api.projects(); report.projectCount = projects.items.length;
            report.chatCount = (await api.chats()).items.length;
            if (projects.items[0]) report.firstProjectChatCount = (await api.projectChats(projects.items[0].id)).items.length;
        } else if (provider === 'deepseek_worker') {
            const data = await workerCatalog({ apiKeys: [process.env.DEEPSEEK_ACCESS_TOKEN] });
            report.modelCount = data.models.length; report.chatCount = data.chats.length;
        } else throw new Error('Unsupported provider');
        report.status = 'passed';
    } catch (error) {
        report.status = 'failed'; report.httpStatus = error.response?.status;
        report.error = 'Account discovery failed; verify credentials, provider availability and server protocol.';
        process.exitCode = 1;
    }
    console.log(JSON.stringify(report, null, 2));
}
if (require.main === module) main();
