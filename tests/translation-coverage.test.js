const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { splitSource, parseCoveredReply, translateComplete, IncompleteTranslationError } = require('../backend/services/completeTranslation.service');
const units = [{ id: '000001', text: 'First source paragraph.' }, { id: '000002', text: 'Last source paragraph.' }];
const answer = '[[abc_000001]]\nالفقرة الأولى.\n[[abc_000002]]\nالفقرة الأخيرة.\n[[END_abc]]';
test('Complete paragraph coverage produces clean Arabic text', () => {
    assert.deepEqual(parseCoveredReply(answer, units, 'abc'), ['الفقرة الأولى.', 'الفقرة الأخيرة.']);
});
for (const [name, response] of [
    ['missing final paragraph despite final punctuation', '[[abc_000001]]\nالفقرة الأولى.\n[[END_abc]]'],
    ['missing final marker', answer.replace('[[END_abc]]', '')],
    ['duplicated paragraph', answer.replace('[[abc_000002]]', '[[abc_000001]]')],
    ['reordered paragraphs', answer.replace('000001', '000003')],
    ['untranslated source', answer.replace('الفقرة الأخيرة.', 'Last source paragraph.')],
    ['empty last paragraph', answer.replace('الفقرة الأخيرة.', '')],
    ['extra trailing explanation', answer + '\nHere is your translation.'],
    ['extra opening explanation', 'Here it is:\n' + answer]
]) test('Coverage rejects ' + name, () => assert.throws(() => parseCoveredReply(response, units, 'abc'), IncompleteTranslationError));
test('Coverage rejects a summary that reproduces all markers', () => {
    const longUnits = units.map(u => ({ ...u, text: 'A detailed event happened here. '.repeat(35) }));
    assert.throws(() => parseCoveredReply(answer, longUnits, 'abc'), /abbreviated/);
});
test('Long Chinese paragraphs split without losing characters', () => {
    const source = '中国小说。'.repeat(1100) + '最后一句。';
    const chunks = splitSource(source, 500);
    assert.equal(chunks.map(p => p.text).join(''), source);
    assert.ok(chunks.every(p => p.text.length <= 500));
});
test('Long unbroken text does not split emoji surrogate pairs', () => {
    const chunks = splitSource('😀'.repeat(2000), 501);
    assert.equal(chunks.map(p => p.text).join(''), '😀'.repeat(2000));
    assert.ok(chunks.every(p => !/[\uD800-\uDBFF]$/.test(p.text)));
});
function respond(prompt) {
    const nonce = prompt.match(/\[\[END_([a-f0-9]+)\]\]/)[1];
    const matches = [...prompt.matchAll(new RegExp(`\\[\\[${nonce}_(\\d{6})\\]\\]`, 'g'))];
    return matches.map((m, i) => {
        const source = prompt.slice(m.index + m[0].length, matches[i + 1]?.index ?? prompt.indexOf('\nTranslate EVERY')).trim();
        return `[[${nonce}_${m[1]}]]\n${/\p{L}/u.test(source) ? 'هذه ترجمة عربية مفصلة تحتوي على جميع الأحداث دون حذف. '.repeat(50) : source}`;
    }).join('\n') + `\n[[END_${nonce}]]`;
}
test('Full real Alice chapter goes through multiple chunks with no missing source units (mock translation)', async () => {
    const source = fs.readFileSync(require.resolve('./fixtures/alice-chapter-1.txt'), 'utf8').trim();
    let calls = 0; const seen = [];
    const result = await translateComplete({ source, prompt: 'Glossary: Alice=أليس\n' + source,
        send: async prompt => { calls++; assert.ok(prompt.includes('Glossary: Alice=أليس')); seen.push(prompt); return respond(prompt); } });
    assert.ok(calls > 3); assert.ok(result.length > 1000); assert.ok(!result.includes('[[END_'));
    for (const unit of splitSource(source)) assert.ok(seen.some(p => p.includes(unit.text)), unit.id);
});
test('Missing coverage retries only the current chunk', async () => {
    let calls = 0;
    const result = await translateComplete({ source: 'An event.', prompt: 'Translate An event.', send: async p => ++calls === 1 ? 'ملخص.' : respond(p) });
    assert.equal(calls, 2); assert.ok(result.includes('ترجمة'));
});
test('Incomplete chapter fails after bounded retries', async () => {
    let calls = 0;
    await assert.rejects(translateComplete({ source: 'An event.', prompt: 'An event.', send: async () => { calls++; return 'ملخص.'; } }), IncompleteTranslationError);
    assert.equal(calls, 3);
});
test('Coverage refuses prompts that omit the full source', async () => {
    await assert.rejects(translateComplete({ source: 'full chapter', prompt: 'short prompt', send: async () => '' }), /Full source/);
});

test('Non-language scene separators are preserved exactly', () => {
    assert.deepEqual(parseCoveredReply('[[abc_000001]]\n*  *  *\n[[END_abc]]', [{ id: '000001', text: '*  *  *' }], 'abc'), ['*  *  *']);
    assert.throws(() => parseCoveredReply('[[abc_000001]]\n...\n[[END_abc]]', [{ id: '000001', text: '*  *  *' }], 'abc'), IncompleteTranslationError);
});

test('Chapter quality gate counts English source words once and handles Cyrillic/CJK', () => {
    const { validateTranslatedChapter } = require('../backend/routes/translatorRoutes')._ai;
    assert.equal(validateTranslatedChapter('نص عربي.', 'one two three').sourceWords, 3);
    assert.equal(validateTranslatedChapter('نص عربي.', 'один два три').sourceWords, 3);
    assert.equal(validateTranslatedChapter('نص عربي.', '中文小说章节').sourceWords, 3);
});
