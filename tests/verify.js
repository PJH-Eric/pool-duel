/* 撞球對決：整合驗證（物理決定性、守恆、規則三種玩法、AI、線上房間）
   執行：node tests/verify.js            （快速套件）
         npm run verify:full              （另跑 20 場 AI 勝率統計，耗時較久）*/
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const D = path.join(__dirname, '..', 'public', 'js') + path.sep;
const P = require(D + 'physics.js'), Rules = require(D + 'rules.js'), AI = require(D + 'ai.js'), RNG = require(D + 'rng.js'), C = require(D + 'physics-config.js');
const full = process.argv.includes('--full') && !process.argv.includes('--quick');
let pass = 0, fail = 0;
function section(t) { console.log('\n● ' + t); }
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }
const setup = (kind, seed) => P.makeWorld([{ id: 0, x: 250, y: 250, pocket: -1 }].concat(P.rack(kind, RNG.create(seed))));
const shotOf = (dx, dy, power) => Object.assign({}, P.quantizeDir(dx, dy), { power, sx: 0, sy: 0 });

section('物理');
{
  const w1 = setup('eight', 1), w2 = setup('eight', 1), s = shotOf(1, 0.01, 1000);
  P.applyShot(w1, s); P.applyShot(w2, s);
  const r1 = P.runToRest(w1), r2 = P.runToRest(w2);
  ok(r1.hash === r2.hash, '相同輸入 → 相同結果（決定性）');
  let overlap = 0;
  for (const a of w1.balls) for (const b of w1.balls) if (a.id < b.id && a.pocket < 0 && b.pocket < 0 && Math.hypot(a.x - b.x, a.y - b.y) < 2 * C.R - 0.6) overlap++;
  ok(overlap === 0, '靜止後沒有球互相重疊');
  ok(w1.balls.every(b => b.pocket >= 0 || (b.x > 0 && b.x < C.W && b.y > 0 && b.y < C.H)), '沒有球飛出桌面');
  ok(!r1.timedOut, '開球能在時限內停下');
  const wa = P.makeWorld([{ id: 0, x: 100, y: 250, pocket: -1 }]); P.applyShot(wa, shotOf(1, 0, 200)); P.runToRest(wa);
  const wb = P.makeWorld([{ id: 0, x: 100, y: 250, pocket: -1 }]); P.applyShot(wb, shotOf(1, 0, 400)); P.runToRest(wb);
  ok(wb.balls[0].x > wa.balls[0].x, '力道越大，母球跑得越遠');
  // 邊袋與角袋
  const side = P.makeWorld([{ id: 0, x: 300, y: 250, pocket: -1 }, { id: 1, x: 500, y: 100, pocket: -1 }]);
  const cornerW = P.makeWorld([{ id: 0, x: 150, y: 150, pocket: -1 }, { id: 1, x: 100, y: 100, pocket: -1 }]);
  P.applyShot(cornerW, shotOf(-1, -1, 300)); const rc = P.runToRest(cornerW);
  ok(rc.pocketed.some(p => p.id === 1), '對準角袋的球可以進袋');
  // 撞擊動量近似守恆：正撞等質量球，母球停、目標球走
  const col = P.makeWorld([{ id: 0, x: 200, y: 250, pocket: -1 }, { id: 1, x: 400, y: 250, pocket: -1 }]);
  P.applyShot(col, shotOf(1, 0, 400)); P.runToRest(col);
  ok(col.balls[1].x > 450 && Math.abs(col.balls[0].x - 370) < 40, '正撞：母球停在目標球前，目標球被推走');
}

section('規則：簡化九球');
{
  const rng = RNG.create(3); let s = Rules.newGame('nine', { breaker: 0 }, rng);
  ok(s.turn === 0 && s.isBreak && s.hand && s.hand.behindHead, '開球：自由球在開球線後');
  ok(Rules.legalFirstIds(s).length === 1 && Rules.legalFirstIds(s)[0] === 1, '必須先碰最小號球');
  // 犯規：先碰錯號球 → 對手自由球
  const w = Rules.prepareWorld(s, { cue: { x: 250, y: 250 }, ...shotOf(1, 0, 600) });
  ok(!!w, '可建立擊球世界');
  // 9 號進袋勝
  const st = Rules.newGame('nine', { breaker: 0 }, RNG.create(1));
  st.isBreak = false; st.hand = null;
  st.balls = st.balls.map(b => (b.id === 0 ? { id: 0, x: 200, y: 250, pocket: -1 } : b.id === 9 ? { id: 9, x: 90, y: 90, pocket: -1 } : b.id === 1 ? { id: 1, x: 150, y: 150, pocket: -1 } : { id: b.id, x: 500 + b.id * 3, y: 500 - 20 * b.id, pocket: 0 }));
  st.balls.find(b => b.id === 1).x = 150;
  // 1 號球在 9 號球前面，母球 → 1 → 9 進角袋 (用規則：直接把 1 設為已進袋、9 在角袋旁)
  st.balls = st.balls.map(b => b.id === 1 ? { id: 1, x: 0, y: 0, pocket: 0 } : b);
  st.balls = st.balls.map(b => b.id === 0 ? { id: 0, x: 170, y: 170, pocket: -1 } : b.id === 9 ? { id: 9, x: 100, y: 100, pocket: -1 } : (b.id >= 2 && b.id <= 8 ? { id: b.id, x: 0, y: 0, pocket: 0 } : b));
  const sh = shotOf(-1, -1, 350); const err = Rules.validateShot(st, sh);
  const ww = Rules.prepareWorld(st, sh); P.applyShot(ww, sh); const res = P.runToRest(ww);
  const info = Rules.evaluateShot(st, sh, res);
  ok(info.state.phase === 'over' && info.state.winner === 0, '先碰最小號後 9 號球進袋 → 本方獲勝' + (err ? '（' + err + '）' : ''));
}

section('規則：八號球（含選擇窗）');
{
  const rng = RNG.create(5); let s = Rules.newGame('eight', { breaker: 0 }, rng);
  ok(s.kind === 'eight' && s.balls.length === 16, '擺球 16 顆');
  let sawChoice = false, over = false;
  for (let seed = 1; seed < 400 && !sawChoice; seed++) {          // 找出開球就出現選擇窗的情況（8 號進袋或犯規）
    const r = RNG.create(seed); const g0 = Rules.newGame('eight', { breaker: 0 }, r);
    const ang = (r.next() - 0.5) * 0.5, sh = Object.assign(shotOf(Math.cos(ang), Math.sin(ang), 1000), { cue: { x: 250, y: 100 + r.next() * 300 } });
    if (Rules.validateShot(g0, sh)) continue;
    const w = Rules.prepareWorld(g0, sh); P.applyShot(w, sh); let g = Rules.evaluateShot(g0, sh, P.runToRest(w)).state;
    if (g.phase === 'choice') { sawChoice = true; const g2 = Rules.resolveChoice(g, Rules.defaultChoice(g), r).state; sawChoice = g2.phase !== 'choice'; }
  }
  for (let seed = 1; seed < 30 && !over; seed++) {
    const r = RNG.create(seed); let g = Rules.newGame('eight', { breaker: seed % 2 }, r), n = 0;
    while (g.phase !== 'over' && n < 300) {
      if (g.phase === 'choice') { g = Rules.resolveChoice(g, Rules.defaultChoice(g), r).state; continue; }
      const { shot } = AI.chooseShot(g, 'normal', r);
      const w = Rules.prepareWorld(g, shot); P.applyShot(w, shot); g = Rules.evaluateShot(g, shot, P.runToRest(w)).state; n++;
    }
    if (g.phase === 'over') over = true;
  }
  ok(sawChoice, '開球出現「接受／重擺」選擇窗並能順利處理');
  ok(over, '八號球整局都能打完並決出勝負');
}

section('規則：14-1 連續進球（叫球、安全球、犯規扣分、重新排球）');
{
  const r = RNG.create(2); let g = Rules.newGame('score', { breaker: 0 }, r);
  ok(g.scores[0] === 0 && g.scores[1] === 0 && g.target === 30, '雙方起始 0 分、目標 30 分');
  let n = 0; while (g.phase !== 'over' && n < 600) { const { shot } = AI.chooseShot(g, 'normal', r); const e = Rules.validateShot(g, shot); if (e) { ok(false, '14-1 AI 出桿不合法：' + e); break; } const w = Rules.prepareWorld(g, shot); P.applyShot(w, shot); g = Rules.evaluateShot(g, shot, P.runToRest(w)).state; n++; }
  ok(g.phase === 'over' && (g.scores[0] >= 30 || g.scores[1] >= 30), '14-1 能打完（先到 30 分）');
  const k = Rules.newGame('score', { breaker: 0, kids: true }, RNG.create(2));
  ok(k.kids === true && !Rules.needCallBall(k), '幼幼班不用叫球');
  // 手工情境：叫球
  const mk = () => { const s = Rules.newGame('score', { breaker: 0 }, RNG.create(5)); s.isBreak = false; s.hand = null; s.balls.forEach(b => { if (b.id > 0) { b.pocket = 5; } }); s.balls[0].x = 300; s.balls[0].y = 250; return s; };
  let s = mk(); const t = s.balls[1]; t.pocket = -1; t.x = 600; t.y = 100; const u = s.balls[2]; u.pocket = -1; u.x = 800; u.y = 400;
  ok(Rules.validateShot(s, { ax: 1e6, ay: 0, power: 400 }) !== null, '沒叫球不能出桿');
  ok(Rules.validateShot(s, { ax: 1e6, ay: 0, power: 400, safety: 1 }) === null, '安全球不用叫球');
  const fake = (pk, ids) => ({ balls: s.balls.map(b => ({ id: b.id, x: b.x, y: b.y, pocket: ids.indexOf(b.id) >= 0 ? pk : b.pocket })), pocketed: ids.map(id => ({ id, pocket: pk })), cueScratch: false, firstContact: t.id, railAfterContact: true, railBalls: [], railBallsAfterContact: [], hitOrder: [], timedOut: false });
  let e = Rules.evaluateShot(s, { ax: 1e6, ay: 0, power: 400, cb: t.id, call: 2 }, fake(2, [t.id, u.id]));
  ok(e.state.scores[0] === 2 && e.state.turn === 0, '叫中：進幾顆算幾分、繼續出桿');
  e = Rules.evaluateShot(s, { ax: 1e6, ay: 0, power: 400, cb: t.id, call: 1 }, fake(2, [t.id]));
  ok(e.state.scores[0] === 0 && e.state.turn === 1 && Rules.getBall(e.state, t.id).pocket < 0, '袋口叫錯：不計分、球歸位、換人');
  e = Rules.evaluateShot(s, { ax: 1e6, ay: 0, power: 400, safety: 1 }, fake(2, [u.id]));
  ok(e.state.scores[0] === 0 && e.state.turn === 1 && !e.state.hand, '安全球：不計分、不罰分、換人');
  const f = fake(2, [t.id]); f.cueScratch = true; f.pocketed.push({ id: 0, pocket: 2 }); f.balls[0].pocket = 2;
  e = Rules.evaluateShot(s, { ax: 1e6, ay: 0, power: 400, cb: t.id, call: 2 }, f);
  ok(e.state.scores[0] === -1 && e.state.turn === 1 && e.state.hand && e.state.hand.player === 1, '犯規：扣 1 分、換人、對手母球自由球');
  // 14 顆進袋 → 重新排球
  s = mk(); const last = s.balls[15]; last.pocket = -1; last.x = 700; last.y = 250; const t2 = s.balls[1]; t2.pocket = -1; t2.x = 600; t2.y = 100;
  e = Rules.evaluateShot(s, { ax: 1e6, ay: 0, power: 400, cb: t2.id, call: 2 }, ((s2) => ({ balls: s2.balls.map(b => ({ id: b.id, x: b.x, y: b.y, pocket: b.id === t2.id ? 2 : b.pocket })), pocketed: [{ id: t2.id, pocket: 2 }], cueScratch: false, firstContact: t2.id, railAfterContact: true, railBalls: [], railBallsAfterContact: [], hitOrder: [], timedOut: false }))(s));
  const ons = Rules.onTable(e.state);
  ok(ons.length === 15 && e.state.turn === 0 && e.state.rackNo === 2 && Rules.getBall(e.state, last.id).x === 700, '第 14 顆進袋：14 顆重新排球、剩下那顆留原處、繼續出桿');
}

section('推桿／定桿／拉桿與滑動');
{
  const run = (x0, x1, pw, sy) => { const w = P.makeWorld([{ id: 0, x: x0, y: 250, pocket: -1 }, { id: 1, x: x1, y: 250, pocket: -1 }]); P.applyShot(w, Object.assign(P.quantizeDir(1, 0), { power: pw, sx: 0, sy })); P.runToRest(w); return w.balls; };
  const contact = x1 => x1 - 2 * C.R;
  const stopSy = Math.round(C.PRESET_STOP * C.SPIN_MAX * 1000) * -1;
  const folSy = Math.round(-C.PRESET_FOLLOW * C.SPIN_MAX * 1000), drawSy = Math.round(-C.PRESET_DRAW * C.SPIN_MAX * 1000);
  let stopOk = true;
  for (const [x0, x1, pw] of [[100, 300, 500], [100, 500, 400], [150, 600, 450]]) { const b = run(x0, x1, pw, stopSy); if (Math.abs(b[0].x - contact(x1)) > 3) stopOk = false; }
  ok(stopOk, '定桿：正撞後母球停在碰撞位置（近、中、遠距離）');
  const f = run(100, 300, 500, folSy)[0].x, n = run(100, 300, 500, 0)[0].x, d = run(100, 300, 500, drawSy)[0].x;
  ok(f > n + 40 && d < n - 40, `推桿往前追（${f.toFixed(0)}）、拉桿往回縮（${d.toFixed(0)}）、平桿停在中間（${n.toFixed(0)}）`);
  const o = run(100, 200, 300, 0)[1].x - 200;
  ok(o > 120, `被擊到的球會滑得夠遠（中力道被撞後滑 ${o.toFixed(0)} 單位）`);
  const w = P.makeWorld([{ id: 0, x: 20, y: 250, pocket: -1 }]); P.applyShot(w, Object.assign(P.quantizeDir(1, 0.02), { power: 1000, sx: 0, sy: 0 }));
  ok(P.runToRest(w).t < 9, '全力一桿能在 9 秒內停下（動畫不會太長）');
}

section('進袋判定（與畫面黑洞一致）');
{
  // 球心落在畫面上黑洞範圍內（靠近桌內的那一側）就必須掉進去；離洞外緣超過寬容度則不會
  let allIn = true, noneOut = true;
  P.POCKETS.forEach((pk, i) => {
    const ix = pk.x < C.W / 2 ? 1 : (pk.x > C.W / 2 ? -1 : 0), iy = pk.y < C.H / 2 ? 1 : -1;
    const n = pk.corner ? Math.hypot(ix, iy) : 1, ux = ix / n, uy = iy / n;
    const inside = (d) => { const w = P.makeWorld([{ id: 0, x: pk.hx + ux * d, y: pk.hy + uy * d, pocket: -1 }]); w.balls[0].vx = ux * -30; w.balls[0].vy = uy * -30; for (let k = 0; k < 6; k++) P.stepWorld(w); return w.balls[0].pocket === i; };
    if (!inside(pk.hr - 2)) allIn = false;            // 球心在黑洞邊緣內側 2 單位
    if (inside(pk.hr + C.CAP_MARGIN + 6)) noneOut = false;   // 球心在黑洞外緣外 9 單位：不該掉
  });
  ok(allIn, '球心在黑洞邊緣內（六個袋口）→ 掉進袋');
  ok(noneOut, '球心離黑洞外緣太遠 → 不會掉進袋');
  let approaches = true;
  for (const scale of [1, C.POCKET_SCALE_BIG]) for (const speed of [180, 900, 2500]) {
    P.POCKETS.forEach((pk, i) => {
      const ux = pk.corner ? (pk.x ? -Math.SQRT1_2 : Math.SQRT1_2) : 0;
      const uy = (pk.y ? -1 : 1) * (pk.corner ? Math.SQRT1_2 : 1);
      const w = P.makeWorld([{ id: 0, x: pk.hx + ux * 60, y: pk.hy + uy * 60 }], { pocketScale: scale });
      w.balls[0].vx = -ux * speed; w.balls[0].vy = -uy * speed;
      P.runToRest(w);
      if (w.balls[0].pocket !== i) approaches = false;
    });
  }
  ok(approaches, '六袋正向入袋：慢／中／高速、標準／加大袋口（36 情境）');
}

section('跳桿');
{
  const mk = (jump, pw) => { const w = P.makeWorld([{ id: 0, x: 100, y: 250, pocket: -1 }, { id: 1, x: 200, y: 250, pocket: -1 }, { id: 2, x: 480, y: 250, pocket: -1 }]); P.applyShot(w, Object.assign(P.quantizeDir(1, 0), { power: pw, sx: 0, sy: 0 }, jump ? { jump: 1 } : {})); const r = P.runToRest(w); return { w, r }; };
  ok(mk(false, 650).r.firstContact === 1, '平打：母球先碰到擋路的 1 號球');
  ok(mk(true, 650).r.firstContact === 2, '跳桿：母球飛過擋路的 1 號球，先碰到後面的 2 號球');
  ok(mk(true, 150).r.firstContact !== 2, '力度小飛不遠：落地後才碰球（不會一路飛過去）');
  ok(mk(true, 650).r.hash === mk(true, 650).r.hash, '跳桿結果具決定性');
}

section('AI');
{
  function play(kind, a, b, seed) {
    const rng = RNG.create(seed); let s = Rules.newGame(kind, { breaker: seed % 2, kids: a === 'kids' && b === 'kids' }, rng), n = 0; const lv = [a, b];
    while (s.phase !== 'over' && n < 1000) {
      if (s.phase === 'choice') { s = Rules.resolveChoice(s, Rules.defaultChoice(s), rng).state; continue; }
      const { shot } = AI.chooseShot(s, lv[s.turn], rng);
      if (Rules.validateShot(s, shot)) return { err: true };
      const w = Rules.prepareWorld(s, shot); P.applyShot(w, shot); s = Rules.evaluateShot(s, shot, P.runToRest(w)).state; n++;
    }
    return { s, n };
  }
  let bad = 0; for (let i = 1; i <= 6; i++) for (const k of ['nine', 'eight', 'score']) { const r = play(k, 'kids', 'kids', i); if (r.err || r.s.phase !== 'over') bad++; }
  ok(bad === 0, '幼幼班 AI 在三種玩法都只出合法擊球並打得完（18 局）');
  if (full) {
    const startedAt = Date.now();
    const N = 10; let hw = 0;
    for (let i = 1; i <= N; i++) { const r = play('score', 'hard', 'easy', i); if (r.s.winner === 0) hw++; }
    ok(hw >= N * 0.7, `14-1：困難 AI 對簡單 AI 贏 ${hw}/${N}（≥70%）`);
    let mw = 0; for (let i = 1; i <= N; i++) { const sw = i % 2, lv = sw ? ['hard', 'myth'] : ['myth', 'hard']; const r = play('score', lv[0], lv[1], i); if (r.s.winner === (sw ? 1 : 0)) mw++; }
    ok(mw >= N * 0.7, `14-1：神話 AI 對困難 AI 贏 ${mw}/${N}（≥70%）`);
    console.log(`  AI 勝率統計耗時 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
  } else {
    console.log('  （快速模式：略過 20 場 AI 勝率統計；完整驗證請執行 npm run verify:full）');
  }
}

section('線上房間／協定');
if (process.argv.includes('--no-online')) console.log('  （略過）');
else {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'online-check.js')], { encoding: 'utf8', timeout: 180000 });
  const m = /結果：(\d+) 通過、(\d+) 失敗/.exec(r.stdout || '');
  ok(!!m && +m[2] === 0, '線上整合檢查 ' + (m ? `${m[1]} 通過、${m[2]} 失敗` : '（無法執行：' + (r.stderr || '').slice(0, 120) + '）'));
}

console.log(`\n總結果：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
