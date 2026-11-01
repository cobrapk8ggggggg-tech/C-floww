const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { readLines } = require('../backend/services/streamLines.service');
const { consumeStreamGenerate, extractSessionTokens, askGeminiWeb } = require('../backend/services/geminiWeb.service');
function frame(text, response = 'r1', choice = 'c1') {
    return JSON.stringify([['wrb.fr', null, JSON.stringify([null, ['conv', response], null, { 26: 'private-csrf' }, [[choice, [text]]]])]]) + '\n';
}
function stream(text, width) {
    const bytes = Buffer.from(text); const chunks = [];
    for (let i = 0; i < bytes.length; i += width) chunks.push(bytes.subarray(i, i + width));
    return Readable.from(chunks);
}
for (const width of [1, 2, 3, 7, 31, 1000]) {
    test(`Gemini parses split JSON/UTF-8 across ${width}-byte chunks`, async () => {
        const response = { data: stream(")]}'\n123\n" + frame('بداية') + frame('بداية ونهاية كاملة.', 'r2', 'c2').trim(), width) };
        const result = await consumeStreamGenerate(response, { conversation_id: 'conv', response_id: 'old' });
        assert.equal(result.text, 'بداية ونهاية كاملة.');
        assert.equal(result.conv.response_id, 'r2'); assert.equal(result.conv.choice_id, 'c2');
        assert.equal(result.conv.at_token, 'private-csrf');
    });
}
test('Gemini accepts final revised snapshot even when shorter', async () => {
    const result = await consumeStreamGenerate({ data: stream(frame('رد طويل غير نهائي.') + frame('الرد النهائي.'), 5) }, null);
    assert.equal(result.text, 'الرد النهائي.');
});
test('Gemini reads every frame in an envelope', async () => {
    const one = JSON.parse(frame('one'))[0], two = JSON.parse(frame('اثنان'))[0];
    const result = await consumeStreamGenerate({ data: stream(JSON.stringify([one, two]), 3) }, null);
    assert.equal(result.text, 'اثنان');
});
test('Gemini stream errors reject partial output', async () => {
    await assert.rejects(consumeStreamGenerate({ data: stream(frame('جزء') + '[ ["er", 123] ]\n', 2) }), /reported an error/);
});
test('Gemini malformed stream does not return silent success', async () => {
    await assert.rejects(consumeStreamGenerate({ data: stream('[bad json]\n', 2) }), /Malformed/);
});
test('readLines propagates a network abort', async () => {
    const input = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('socket closed'); })());
    await assert.rejects(readLines(input, () => {}), /socket closed/);
});
test('readLines handles CRLF and final record without newline', async () => {
    const lines = []; await readLines(stream('أول\r\nثان', 1), line => lines.push(line)); assert.deepEqual(lines, ['أول', 'ثان']);
});
test('Gemini refuses implicit guest mode', async () => {
    await assert.rejects(askGeminiWeb('test', {}), /مطلوبة/);
});
test('Session token parser extracts signed numeric session IDs', () => {
    assert.deepEqual(extractSessionTokens('"SNlM0e":"csrf","FdrFJe":"-123"'), { snlm0e: 'csrf', fdrfje: '-123' });
});
module.exports = { frame, stream };
