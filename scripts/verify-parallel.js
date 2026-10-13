'use strict';
const path = require('path');
const { spawn } = require('child_process');
const startedAt = Date.now();
const suites = [
  ['物理／規則／AI', 'verify.js', '--no-online', ...process.argv.slice(2)],
  ['線上整合', 'online-check.js'],
];

Promise.all(suites.map(([name, file, ...args]) => new Promise(resolve => {
  const start = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'tests', file), ...args], {
    stdio: 'inherit', timeout: file === 'online-check.js' ? 180000 : 0,
  });
  child.on('error', error => console.error(`${name} 無法啟動：${error.message}`));
  child.on('close', code => {
    console.log(`${name}：${code === 0 ? '通過' : '失敗'}，耗時 ${((Date.now() - start) / 1000).toFixed(1)} 秒`);
    resolve(code === 0);
  });
}))).then(results => {
  console.log(`並行驗證總耗時 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
});
