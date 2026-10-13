'use strict';
const [site, expected] = process.argv.slice(2);
if (!site || !/^[a-f0-9]{40}$/.test(expected || '')) {
  console.error('用法：node scripts/check-deployment.js <網站網址> <完整 commit SHA>');
  process.exit(1);
}

(async () => {
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const url = new URL('version.json', site.endsWith('/') ? site : site + '/');
      url.searchParams.set('check', `${expected}-${Date.now()}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
      if (response.ok && (await response.json()).commit === expected) {
        console.log(`線上版本確認成功：${expected}`);
        return;
      }
    } catch (error) {
      console.log(`第 ${attempt} 次確認：${error.message}`);
    }
    if (attempt < 12) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error('線上版本尚未符合本次部署，請檢查 Pages／CDN 狀態');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
