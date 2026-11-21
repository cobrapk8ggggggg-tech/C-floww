const crypto = require('node:crypto');
class IncompleteTranslationError extends Error {
    constructor(message) { super(message); this.name = 'IncompleteTranslationError'; }
}
function splitSource(source, maxChars = 2400) {
    const paragraphs = String(source).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const units = [];
    for (const paragraph of paragraphs) {
        let rest = paragraph;
        while (rest.length > maxChars) {
            const candidate = rest.slice(0, maxChars);
            let cut = Math.max(candidate.lastIndexOf('。') + 1, candidate.lastIndexOf('. ') + 1,
                candidate.lastIndexOf('! ') + 1, candidate.lastIndexOf('? ') + 1, candidate.lastIndexOf('\n'));
            if (cut < maxChars / 2) cut = candidate.lastIndexOf(' ');
            if (cut < maxChars / 2) cut = maxChars;
            if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
            units.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
        }
        if (rest) units.push(rest);
    }
    return units.map((text, i) => ({ id: String(i + 1).padStart(6, '0'), text }));
}
function magnitude(text) {
    const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff]/g) || []).length;
    return (text.match(/[\p{L}\p{N}]+/gu) || []).filter(w => !/[\u3400-\u9fff\u3040-\u30ff]/.test(w)).length + cjk / 2;
}
function parseCoveredReply(reply, units, nonce) {
    const end = `[[END_${nonce}]]`;
    if (!reply.trim().endsWith(end)) throw new IncompleteTranslationError('Missing translation end marker');
    const pattern = new RegExp(`\\[\\[${nonce}_(\\d{6})\\]\\]`, 'g');
    const matches = [...reply.matchAll(pattern)];
    if (matches.length !== units.length || matches.some((m, i) => m[1] !== units[i].id)) {
        throw new IncompleteTranslationError('Missing, repeated or reordered source paragraphs');
    }
    if (reply.slice(0, matches[0].index).trim()) throw new IncompleteTranslationError('Unexpected text before translation');
    return matches.map((m, i) => {
        const text = reply.slice(m.index + m[0].length, matches[i + 1]?.index ?? reply.lastIndexOf(end)).trim();
        const arabic = (text.match(/[\u0621-\u064a]+/g) || []).length;
        const hasWords = /\p{L}/u.test(units[i].text);
        if (!text || (hasWords && !arabic) || (!hasWords && text.replace(/\s/g, '') !== units[i].text.replace(/\s/g, '')) || (magnitude(units[i].text) >= 40 && arabic < magnitude(units[i].text) * 0.35)) {
            throw new IncompleteTranslationError('Empty, untranslated or suspiciously abbreviated paragraph ' + units[i].id);
        }
        return text;
    });
}
function durableUnits(source, maxChars, groupFrom, wholeChapter = false) {
    if (wholeChapter) return [{ id: '000001', text: source }];
    const units = splitSource(source, maxChars);
    if (groupFrom == null) return units;
    const grouped = units.slice(0, groupFrom).map(unit => unit.text);
    let batch = [];
    let size = 0;
    for (const unit of units.slice(groupFrom)) {
        if (batch.length && (batch.length === 8 || size + 2 + unit.text.length > maxChars)) {
            grouped.push(batch.join('\n\n'));
            batch = [];
            size = 0;
        }
        size += (batch.length ? 2 : 0) + unit.text.length;
        batch.push(unit.text);
    }
    if (batch.length) grouped.push(batch.join('\n\n'));
    return grouped.map((text, i) => ({ id: String(i + 1).padStart(6, '0'), text }));
}

function parseDurableReply(reply, unit, nonce) {
    const end = `[[END_${nonce}]]`;
    let value = reply.trim();
    const fence = value.match(/^```[^\r\n]*\r?\n([\s\S]+)\r?\n```$/);
    if (fence) value = fence[1].trim();
    if (!value.endsWith(end) || value.indexOf(end) !== value.lastIndexOf(end)) {
        throw new IncompleteTranslationError('Missing or repeated translation end marker');
    }
    let arabic = value.slice(0, -end.length).trim();
    // A single-unit request identifies the source independently. An omitted
    // opener or the model's equivalent single-bracket tag does not lose a unit.
    const opener = arabic.match(/^\[{1,2}([a-z\d_]{1,32})\]{1,2}\s*/i);
    const idMatches = id => /^\d{1,6}$/.test(id) && Number(id) === Number(unit.id);
    if (opener) {
        const label = opener[1];
        const suffix = label.startsWith(`${nonce}_`) ? label.slice(nonce.length + 1) : '';
        if (label === nonce || idMatches(label) || /^\d{1,6}$|^NNNNNN$/.test(suffix)) arabic = arabic.slice(opener[0].length);
    }
    if (/\[\[[a-z\d_]{1,32}\]\]|```/i.test(arabic) || /^\[[a-z\d_]{8,32}\]/i.test(arabic)) {
        throw new IncompleteTranslationError('Unexpected translation markers');
    }
    const paragraphs = unit.text.trim().split(/\n\s*\n/);
    const lines = arabic.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length < paragraphs.length || paragraphs.some(p => !/\p{L}/u.test(p) && !lines.includes(p.trim()))) {
        throw new IncompleteTranslationError('Missing translated paragraphs or separators');
    }
    return parseCoveredReply(`[[${nonce}_${unit.id}]]\n${arabic}\n${end}`, [unit], nonce)[0];
}
async function translateComplete({ source, prompt, send, chunkSize = 2400, retries = 2, log }) {
    if (!source?.trim() || !prompt.includes(source)) throw new Error('Full source must be included in translation prompt');
    const units = splitSource(source, chunkSize);
    const result = [];
    for (let start = 0; start < units.length;) {
        const batch = []; let size = 0;
        while (start < units.length && (!batch.length || size + units[start].text.length <= chunkSize)) {
            size += units[start].text.length; batch.push(units[start++]);
        }
        const nonce = crypto.randomBytes(6).toString('hex');
        const marked = batch.map(u => `[[${nonce}_${u.id}]]\n${u.text}`).join('\n\n');
        const instruction = `\nTranslate EVERY supplied paragraph fully into Arabic without summarizing or omitting sentences.\nPreserve non-language separators (stars, numbers, punctuation) exactly.\nKeep each [[${nonce}_NNNNNN]] marker exactly once in its original order, followed by its complete Arabic translation.\nOutput only these marked translations, then [[END_${nonce}]] on its own final line. This is a section of a longer chapter; do not invent an ending.\n`;
        let translated;
        for (let attempt = 0; attempt <= retries; attempt++) {
            const reply = await send(prompt.replace(source, marked) + instruction);
            try { translated = parseCoveredReply(reply, batch, nonce); break; }
            catch (err) {
                if (!(err instanceof IncompleteTranslationError) || attempt === retries) throw err;
                if (log) await log(`إعادة ترجمة الفقرات ${batch[0].id}–${batch.at(-1).id}: فشل فحص الاكتمال`, 'warning');
            }
        }
        result.push(...translated);
        if (log) await log(`اكتملت تغطية ${start}/${units.length} فقرة/جزء من الفصل`, 'info');
    }
    return result.join('\n\n');
}
module.exports = { translateComplete, splitSource, parseCoveredReply, durableUnits, parseDurableReply, IncompleteTranslationError };
