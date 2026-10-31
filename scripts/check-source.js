const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const parser = require('../backend/node_modules/@babel/parser');
const root = path.join(__dirname, '..');
function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' ? [] : e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
let count = 0;
for (const file of files(path.join(root, 'backend')).concat(files(path.join(root, 'web')), files(path.join(root, 'scripts')), files(path.join(root, 'tests')))) {
    if (!file.endsWith('.js')) continue;
    if (file.includes('/backend/')) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    else parser.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] });
    count++;
}
console.log(`Parsed ${count} JavaScript/JSX files successfully.`);
