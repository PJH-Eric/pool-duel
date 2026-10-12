/* 版面檢查（需要本機有 Playwright：npm i -g playwright）。先 npm start，再執行：
   node scripts/layout-check.js [輸出資料夾]
   會在各種尺寸跑首頁→設定→對電腦開局，檢查主控台錯誤與橫向捲動，並存截圖。 */
'use strict';
const fs = require('fs'), path = require('path');
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { console.log('找不到 playwright，略過'); process.exit(0); }
const out = process.argv[2] || path.join(__dirname, '..', 'tests', 'shots'); fs.mkdirSync(out, { recursive: true });
const URL = process.env.URL || 'http://localhost:3160/';
const SIZES = [['desktop', 1600, 900], ['tablet-l', 1180, 820], ['tablet-p', 820, 1180], ['phone-l', 844, 390], ['phone-p', 390, 844]];
(async () => {
  const b = await chromium.launch(); let bad = 0;
  for (const [n, w, h] of SIZES) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: w < 1000, isMobile: w < 1000 }), p = await ctx.newPage(), errs = [];
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await p.waitForTimeout(600); await p.screenshot({ path: path.join(out, n + '-home.png') });
    await p.click('#btnSolo'); await p.click('#btnStartSolo'); await p.waitForTimeout(1200); await p.screenshot({ path: path.join(out, n + '-game.png') });
    const ov = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    console.log(`${ov || errs.length ? '✗' : '✓'} ${n} ${w}x${h}` + (ov ? ' 有橫向捲動' : '') + (errs.length ? ' 錯誤：' + errs[0] : ''));
    if (ov || errs.length) bad++; await ctx.close();
  }
  await b.close(); process.exit(bad ? 1 : 0);
})();
