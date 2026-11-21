// Opt-in real-account tests. Credentials and prompts are never printed.
const fs = require('node:fs');
const path = require('node:path');
const axios = require('../backend/node_modules/axios');
const { askGeminiWeb } = require('../backend/services/geminiWeb.service');
const { ChatGPTAndroid } = require('../backend/services/chatgptAndroid.service');
const { askDeepSeekWorker } = require('../backend/services/deepseekWorker.service');
const { validateTranslatedChapter, translateResiduesOnly } = require('../backend/routes/translatorRoutes')._ai;
const { translateComplete, splitSource } = require('../backend/services/completeTranslation.service');
function readCookies(file) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const header = raw.match(/^export BROWSER_COOKIE_HEADER=(['"])(.*?)\1\s*$/m);
    if (header) return header[2];
    if (/^export /m.test(raw)) throw new Error('Cookie export must contain BROWSER_COOKIE_HEADER');
    return raw;
}
async function fetchChapter() {
    const { data } = await axios.get('https://www.gutenberg.org/files/11/11-0.txt', { timeout: 60000, responseType: 'text' });
    const heading = 'CHAPTER I.\nDown the Rabbit-Hole';
    const start = data.lastIndexOf(heading);
    const end = data.indexOf('CHAPTER II.', start + heading.length);
    if (start < 0 || end < 0) throw new Error('Could not locate complete Alice chapter I');
    return data.slice(start, end).trim();
}
async function main() {
    const provider = process.env.LIVE_PROVIDER || 'gemini';
    const source = await fetchChapter();
    const fixture = path.join(__dirname, '../tests/fixtures/alice-chapter-1.txt');
    fs.writeFileSync(fixture, source + '\n');
    const result = { provider, source: 'https://www.gutenberg.org/files/11/11-0.txt', chapter: 'Alice in Wonderland — chapter I',
        sourceChars: source.length, sourceUnits: splitSource(source).length, date: new Date().toISOString(), completedUnits: 0, status: 'running' };
    let send, validationProvider, credential;
    const context = {};
    if (provider === 'gemini') {
        const token = process.env.GEMINI_COOKIE_HEADER || (process.env.GOOGLE_COOKIES_FILE && readCookies(process.env.GOOGLE_COOKIES_FILE));
        if (!token) throw new Error('GEMINI_COOKIE_HEADER or GOOGLE_COOKIES_FILE is required');
        credential = token;
        validationProvider = { providerId: 'gemini_web_live', selectedModel: 'gemini-web', geminiAccountIndex: Number(process.env.GEMINI_ACCOUNT_INDEX ?? 1) };
        send = prompt => askGeminiWeb(prompt, { token, context, accountIndex: Number(process.env.GEMINI_ACCOUNT_INDEX ?? 1),
            timeout: 180000, allowGuestFallback: false, autoContinue: false });
    } else if (provider === 'chatgpt') {
        credential = process.env.CHATGPT_ACCESS_TOKEN;
        validationProvider = { providerId: 'chatgpt_live', chatgptAccountId: process.env.CHATGPT_ACCOUNT_ID, selectedModel: process.env.CHATGPT_MODEL || 'auto' };
        const client = new ChatGPTAndroid(process.env.CHATGPT_ACCESS_TOKEN, process.env.CHATGPT_ACCOUNT_ID);
        send = prompt => client.send(prompt, { context, model: process.env.CHATGPT_MODEL || 'auto' });
    } else if (provider === 'deepseek_worker') {
        credential = process.env.DEEPSEEK_ACCESS_TOKEN;
        validationProvider = { providerId: 'deepseek_worker_live', selectedModel: 'deepseek-chat' };
        send = prompt => askDeepSeekWorker(prompt, { token: process.env.DEEPSEEK_ACCESS_TOKEN, context });
    } else throw new Error('Unsupported LIVE_PROVIDER');
    try {
        let translated = await translateComplete({ source, prompt: 'Translate this complete novel chapter into Arabic, preserving every detail.\n\n' + source,
            send, log: msg => { const m = msg.match(/(\d+)\/(\d+)/); if (m) result.completedUnits = Number(m[1]); console.log(msg); } });
        let validation = validateTranslatedChapter(translated, source);
        if (validation.residues.length) {
            result.residueRepairCount = validation.residues.length;
            translated = await translateResiduesOnly(validationProvider, validationProvider.selectedModel, credential,
                translated, validation.residues, { conversationPurpose: 'review' });
            validation = validateTranslatedChapter(translated, source);
        }
        if (!validation.ok) throw new Error('Final chapter validation failed');
        result.chapterValidationPassed = true;
        const outputDir = process.env.LIVE_OUTPUT_DIR || path.join(__dirname, '../.local-live');
        fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(outputDir, provider + '-alice-ar.txt'), translated, { mode: 0o600 });
        result.outputChars = translated.length;
        result.status = 'passed-structural-coverage';
    } catch (err) {
        result.status = 'failed';
        result.error = err.isAxiosError ? `HTTP/network failure (${err.response?.status || err.code || 'unknown'})` :
            /GeminiWebAuthError|IncompleteTranslationError/.test(err.name) ? err.message : 'Provider test failed; check account configuration';
        process.exitCode = 1;
    }
    const report = process.env.LIVE_REPORT_FILE || path.join(__dirname, '../.local-live/report.json');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(err => { console.error(err.isAxiosError ? `HTTP/network failure (${err.response?.status || err.code})` : err.message); process.exitCode = 1; });
module.exports = { readCookies, fetchChapter };
