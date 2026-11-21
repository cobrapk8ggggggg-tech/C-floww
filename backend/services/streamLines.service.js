const { StringDecoder } = require('node:string_decoder');

// Keep both incomplete UTF-8 characters and incomplete records across TCP chunks.
async function readLines(stream, onLine) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    for await (const chunk of stream) {
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
            onLine(pending.slice(0, end).replace(/\r$/, ''));
            pending = pending.slice(end + 1);
        }
        if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new Error('Provider stream record exceeds 16 MB');
    }
    pending += decoder.end();
    if (pending.trim()) onLine(pending.replace(/\r$/, ''));
}
module.exports = { readLines };
