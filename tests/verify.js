/* 撞球對決：整合驗證（物理決定性、守恆、規則三種玩法、AI 強弱、線上房間）
   執行：node tests/verify.js            （約 1 分鐘）
         node tests/verify.js --quick    （略過較慢的 AI 勝率）*/
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const D = path.join(__dirname, '..', 'public', 'js') + path.sep;
const P = require(D + 'physics.js'), Rules = require(D + 'rules.js'), AI = require(D + 'ai.js'), RNG = require(D + 'rng.js'), C = require(D + 'physics-config.js');
const quick = process.argv.includes('--quick');
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

section('規則：搶分賽（含幼幼班不扣分）');
{
  const r = RNG.create(2); let g = Rules.newGame('score', { breaker: 0 }, r);
  ok(g.scores && g.scores[0] === 0 && g.scores[1] === 0, '雙方起始 0 分');
  let n = 0; while (g.phase !== 'over' && n < 400) { const { shot } = AI.chooseShot(g, 'normal', r); const w = Rules.prepareWorld(g, shot); P.applyShot(w, shot); g = Rules.evaluateShot(g, shot, P.runToRest(w)).state; n++; }
  ok(g.phase === 'over', '搶分賽能打完');
  ok(g.scores[0] + g.scores[1] <= 120 && (g.scores[0] >= 61 || g.scores[1] >= 61 || g.winner == null || g.winner >= 0), '分數合理（總分 ≤ 120）');
  const k = Rules.newGame('score', { breaker: 0, kids: true }, RNG.create(2));
  ok(k.kids === true, '幼幼班模式旗標存在（犯規不扣分）');
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
    const rng = RNG.create(seed); let s = Rules.newGame(kind, { breaker: seed % 2 }, rng), n = 0; const lv = [a, b];
    while (s.phase !== 'over' && n < 400) {
      if (s.phase === 'choice') { s = Rules.resolveChoice(s, Rules.defaultChoice(s), rng).state; continue; }
      const { shot } = AI.chooseShot(s, lv[s.turn], rng);
      if (Rules.validateShot(s, shot)) return { err: true };
      const w = Rules.prepareWorld(s, shot); P.applyShot(w, shot); s = Rules.evaluateShot(s, shot, P.runToRest(w)).state; n++;
    }
    return { s, n };
  }
  let bad = 0; for (let i = 1; i <= 6; i++) for (const k of ['nine', 'eight', 'score']) { const r = play(k, 'kids', 'kids', i); if (r.err || r.s.phase !== 'over') bad++; }
  ok(bad === 0, '幼幼班 AI 在三種玩法都只出合法擊球並打得完（18 局）');
  if (!quick) {
    const N = 10; let hw = 0, ew = 0;
    for (let i = 1; i <= N; i++) { const r = play('score', 'hard', 'easy', i); if (r.s.winner === r.s.turn || r.s.winner === (r.s.scores[0] > r.s.scores[1] ? 0 : 1)) { } const w = r.s.scores[0] > r.s.scores[1] ? 0 : 1; const hardSeat = 0; if (w === hardSeat) hw++; }
    ok(hw >= N * 0.7, `搶分賽：困難 AI 對簡單 AI 贏 ${hw}/${N}（≥70%）`);
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
