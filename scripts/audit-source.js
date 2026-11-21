const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const parser = require('../backend/node_modules/@babel/parser');
const source = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const files = execFileSync('git', ['ls-files'], { cwd: source, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const entries = files.map(file => {
    const buffer = fs.readFileSync(path.join(source, file));
    const textFile = !/\.(png|ttf|jpg|ico|zip)$/i.test(file);
    const text = textFile ? buffer.toString('utf8') : '';
    const entry = { path: file, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        type: textFile ? 'text' : 'binary', ...(textFile ? { lines: text.split('\n').length } : {}) };
    if (file.endsWith('.js')) {
        const ast = parser.parse(text, { sourceType: 'unambiguous', plugins: ['jsx'] });
        const functions = [], imports = new Set(), routes = [];
        function visit(node) {
            if (!node || typeof node !== 'object') return;
            if (node.type === 'FunctionDeclaration' && node.id) functions.push(node.id.name);
            if (node.type === 'ImportDeclaration') imports.add(node.source.value);
            if (node.type === 'CallExpression') {
                if (node.callee?.name === 'require' && typeof node.arguments[0]?.value === 'string') imports.add(node.arguments[0].value);
                if (node.callee?.object?.name === 'app' && ['get','post','put','delete','patch'].includes(node.callee.property?.name) && typeof node.arguments[0]?.value === 'string') {
                    routes.push({ method: node.callee.property.name.toUpperCase(), path: node.arguments[0].value, middleware: node.arguments.slice(1, -1).filter(n => n.type === 'Identifier').map(n => n.name) });
                }
            }
            for (const [key, value] of Object.entries(node)) {
                if (['loc','start','end','extra','comments','tokens'].includes(key)) continue;
                if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
            }
        }
        visit(ast.program); entry.functions = functions; entry.imports = [...imports]; entry.routes = routes;
    }
    return entry;
});
const result = { source: 'https://github.com/zeus82256-lang/C-app-new', revision: execFileSync('git', ['rev-parse','HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
    files: entries.length, textFiles: entries.filter(f => f.type === 'text').length,
    textLines: entries.reduce((sum, f) => sum + (f.lines || 0), 0), entries };
fs.writeFileSync(path.join(__dirname, '../docs/source-inventory.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ files: result.files, textFiles: result.textFiles, textLines: result.textLines, revision: result.revision }));
