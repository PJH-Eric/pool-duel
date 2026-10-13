'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const files = ['server.js'];

function collect(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.name.endsWith('.js')) files.push(file);
  }
}

for (const directory of ['public/js', 'tests', 'scripts']) collect(directory);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error(`${file} 語法檢查失敗：${result.error || result.stderr}`);
    process.exit(1);
  }
}
console.log(`JavaScript 語法檢查：${files.length} 個檔案通過`);
