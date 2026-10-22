/* 線上流程實測：真的開伺服器、用 Node 內建 WebSocket 連。
   涵蓋：開房／加入／準備／開始／出桿（伺服器權威）／觀戰／邀請／聊天／斷線 30 秒重連／逾時判負／房間關閉。 */
'use strict';
const path = require('path');
process.env.PORT = process.env.PORT || '0';
const RNG = require('../public/js/rng.js');
// 固定伺服器擺球種子，讓完整對局與耗時可重現；只影響這個測試程序。
RNG.newSeed = () => 'online-check-1';
const srv = require('../server.js');
const AI = require('../public/js/ai.js');
const Rules = require('../public/js/rules.js');

let pass = 0, failN = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ✓ ' + name); } else { failN++; console.log('  ✗ ' + name); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(port, name, cid) {
  const c = { name, cid, msgs: [], ws: null, room: null, game: null, state: null };
  c.open = () => new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    c.ws = ws;
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data); c.msgs.push(m);
      if (m.type === 'hb') ws.send(JSON.stringify({ type: 'hb' }));
      if (m.type === 'room') c.room = m.room;
      if (m.type === 'joined') c.room = m.room;
      if (m.type === 'game') { c.game = m.game; c.state = m.game.state; }
      if (m.type === 'settle' || m.type === 'state') c.state = m.state;
    };
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', name, clientId: cid })); res(); };
    ws.onerror = rej;
  });
  c.send = o => c.ws.send(JSON.stringify(o));
  c.wait = async (type, ms = 3000, from = 0) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const f = c.msgs.slice(from).find(m => m.type === type); if (f) return f; await sleep(20); }
    return null;
  };
  c.close = () => { try { c.ws.close(); } catch (e) {} };
  return c;
}

(async () => {
  await new Promise(r => srv.server.listen(0, r));
  const port = srv.server.address().port;
  console.log('伺服器埠 ' + port);

  console.log('● 基本：健康檢查');
  const h = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
  ok(h.ok && h.game === 'pool-duel', '/health 回應');
  console.log('● 開房、加入、準備、開始');
  const A = client(port, '小明', 'client-aaaaaaaa'), B = client(port, '小華', 'client-bbbbbbbb');
  await A.open(); await B.open();
  await A.wait('welcome'); await B.wait('welcome');
  A.send({ type: 'create', name: '測試房', kind: 'eight', turnSec: 30, pockets: 'big' });
  const joined = await A.wait('joined');
  ok(joined && joined.role === 'player' && joined.room.cfg.kind === 'eight' && joined.room.cfg.pockets === 'big' && joined.room.cfg.turnSec === 35, '房主開房（固定 35 秒、八號球、加大袋口）');
  const cfgFrom = A.msgs.length;
  A.send({ type: 'config', turnSec: 60 });
  const fixedCfg = await A.wait('room', 2000, cfgFrom);
  ok(fixedCfg && fixedCfg.room.cfg.turnSec === 35, '房間不能把回合時間改成其他值');
  B.send({ type: 'join', roomId: joined.roomId });
  await B.wait('joined');
  ok(B.room.members.length === 2 && B.room.members.find(m => m.name === '小華').seat === 1, '第二人坐 P2');
  A.send({ type: 'ready', ready: true }); B.send({ type: 'ready', ready: true });
  await sleep(150);
  A.send({ type: 'start' });
  const g = await B.wait('game');
  const firstRoundId = g && g.game.roundId;
  ok(Number.isInteger(firstRoundId), '開局提供穩定的對局識別');
  ok(g && g.game.state.kind === 'eight' && g.game.state.balls.length === 16 && g.game.state.bigPockets, '開局：球擺好、加大袋口');
  ok(g && g.game.turnMs >= 34500 && g.game.turnMs <= 35000 && g.game.extensionUsed.every(x => !x), '線上開局倒數 35 秒且每盤延長次數重置');

  console.log('● 觀戰與邀請');
  A.send({ type: 'invite' });
  const inv = await A.wait('invite');
  ok(inv && inv.token, '房主產生邀請');
  const S = client(port, '觀眾', 'client-ssssssss'); await S.open(); await S.wait('welcome');
  S.send({ type: 'invite:peek', token: inv.token });
  const info = await S.wait('invite:info');
  ok(info && info.ok && info.full, '邀請預覽：對局中只能觀戰');
  S.send({ type: 'invite:resolve', token: inv.token, name: '觀眾甲' });
  const sj = await S.wait('joined');
  ok(sj && sj.role === 'spectator' && S.game && S.game.state.balls.length === 16, '以邀請加入＝觀戰，並收到完整局面');
  const bad = client(port, '路人', 'client-xxxxxxxx'); await bad.open(); await bad.wait('welcome');
  bad.send({ type: 'invite:resolve', token: 'nope' });
  const be = await bad.wait('error');
  ok(be && be.text === 'err.inviteInvalid', '無效邀請有可理解的提示');
  A.send({ type: 'chat', text: '大家好' });
  await sleep(150);
  ok(S.room && S.room.chat.some(c => c.text === '大家好'), '聊天觀戰者看得到');

  console.log('● 每盤延長一次與權限');
  const active = g.game.state.turn === 0 ? A : B;
  const passive = active === A ? B : A;
  let extensionFrom = passive.msgs.length;
  passive.send({ type: 'extend' });
  const wrongTurn = await passive.wait('error', 2000, extensionFrom);
  ok(wrongTurn && wrongTurn.code === 'extension', '非目前回合玩家不能延長');
  extensionFrom = S.msgs.length;
  S.send({ type: 'extend' });
  const spectatorError = await S.wait('error', 2000, extensionFrom);
  ok(spectatorError && spectatorError.code === 'extension', '觀戰者不能延長');
  const extFrom = { A: A.msgs.length, B: B.msgs.length, S: S.msgs.length };
  active.send({ type: 'extend' });
  const extended = await active.wait('extension', 2000, extFrom[active === A ? 'A' : 'B']);
  const observedExtension = await S.wait('extension', 2000, extFrom.S);
  ok(extended && extended.extensionUsed[active === A ? 0 : 1] && extended.turnMs >= 58500 && extended.turnMs <= 60000, '輪到的玩家延長成功，剩餘時間增加 25 秒');
  ok(observedExtension && observedExtension.extensionUsed.some(Boolean), '延長結果同步給對手與觀戰者');
  extensionFrom = active.msgs.length;
  active.send({ type: 'extend' });
  const repeated = await active.wait('error', 2000, extensionFrom);
  ok(repeated && repeated.code === 'extension', '本盤已延長後再次操作會被拒絕');

  console.log('● 伺服器權威出桿');
  let st = A.state;
  const seatOf = st.turn;
  const shooter = seatOf === 0 ? A : B, other = seatOf === 0 ? B : A;
  const wrongShotFrom = other.msgs.length;
  other.send({ type: 'shot', shot: { ax: 1000000, ay: 0, power: 500 } });
  const er = await other.wait('error', 3000, wrongShotFrom);
  ok(er && er.text === 'err.notYourTurn', '還沒輪到的人出桿被拒');
  const rng = RNG.create('t');
  const pick = AI.chooseShot(st, 'normal', rng);
  const from = shooter.msgs.length;
  shooter.send({ type: 'shot', shot: pick.shot });
  const sm = await S.wait('shot'), se = await S.wait('settle');
  ok(sm && se && sm.shotNo === 1, '出桿：觀戰者收到 shot 與 settle');
  // 本地重播同一桿 → 與伺服器結果一致
  const P = require('../public/js/physics.js');
  const w = Rules.prepareWorld(st, pick.shot); P.applyShot(w, pick.shot); const res = P.runToRest(w);
  ok(res.hash === se.hash, '本地重播的結果雜湊與伺服器一致（確定性）：' + res.hash);
  const bad2 = { ax: 1e9, ay: 0, power: 500 };
  const cur = se.state.turn;
  (cur === 0 ? A : B).send({ type: 'shot', shot: bad2 });
  const er2 = await (cur === 0 ? A : B).wait('error', 2000, (cur === 0 ? A : B).msgs.length - 1);
  ok(!!er2, '亂填的出桿資料被拒');

  console.log('● 對局打到分出勝負（用電腦出桿代打）');
  let guard = 0;
  while (A.state.phase !== 'over' && guard++ < 120) {
    await sleep(30);
    const s = A.state;
    if (s.phase === 'choice') { const pl = s.pending.player; (pl === 0 ? A : B).send({ type: 'choice', choice: Rules.defaultChoice(s) }); await sleep(120); continue; }
    const cl = s.turn === 0 ? A : B;
    const sh = AI.chooseShot(s, 'hard', rng).shot;
    const n0 = cl.msgs.length;
    cl.send({ type: 'shot', shot: sh });
    // 等到雙方 state 更新
    const t0 = Date.now(); const before = s.shotNo;
    while (Date.now() - t0 < 4000 && A.state.shotNo === before && A.state.phase !== 'over') await sleep(20);
    await sleep(60);
    // 模擬客戶端動畫時間：伺服器要求球停才能下一桿
    const last = cl.msgs.slice(n0).find(m => m.type === 'shot');
    await sleep(Math.min(last ? last.simMs : 0, 1500) + 50);
  }
  ok(A.state.phase === 'over' && A.state.winner != null, '一局打完：勝者 P' + (A.state.winner + 1) + '（' + A.state.reason + '）共 ' + A.state.shotNo + ' 桿');
  await sleep(200);
  ok(A.room.phase === 'result', '房間進入結算');

  console.log('● 再來一局（換開球）與回到房間');
  const firstBreaker = A.state.breaker;
  A.send({ type: 'rematch' }); await sleep(100);
  ok(A.room.members.find(m => m.id === A.room.members[0].id) && A.room.phase === 'result', '一人按再來一局：等對方');
  B.send({ type: 'rematch' });
  const g2 = await A.wait('game', 3000, A.msgs.length);
  await sleep(100);
  ok(A.state.phase === 'play' && A.state.breaker !== firstBreaker && A.state.shotNo === 0 && g2 && g2.game.extensionUsed.every(x => !x), '雙方同意：新局開始、開球權互換並重置延長');
  ok(g2 && g2.game.roundId > firstRoundId, '相同擺球種子重玩仍有不同對局識別');

  console.log('● 斷線 30 秒保留與重連');
  const bId = B.room.members.find(m => m.name === '小華').id;
  B.close(); await sleep(300);
  ok(A.room.dc && A.room.dc.id === bId && A.room.dc.ms > 25000, '對手看到斷線倒數');
  const B2 = client(port, '小華', 'client-bbbbbbbb'); await B2.open();
  const rj = await B2.wait('joined');
  ok(rj && rj.rejoined && rj.role === 'player' && B2.game && B2.game.state.balls.length === 16, '同一個瀏覽器分頁重連：回到原席位並補送局面');
  ok(B2.game && g2 && B2.game.roundId === g2.game.roundId, '重連沿用同一對局識別，避免重複開局統計');
  await sleep(1300);
  ok(!A.room.dc, '重連後倒數消失');

  console.log('● 對局中離開＝判負；房間在真人玩家都離開後關閉');
  B2.send({ type: 'leave' }); await sleep(300);
  ok(A.state.phase === 'over' && A.state.winner === A.room.members.find(m => m.name === '小明').seat, '對手離開：留下的人獲勝');
  A.send({ type: 'leave' }); await sleep(400);
  const closed = S.msgs.find(m => m.type === 'closed');
  ok(!!closed, '玩家都走了：觀戰者收到「房間已結束」');
  ok(srv.hub.rooms.size === 0, '房間已移除、邀請失效');
  S.send({ type: 'invite:resolve', token: inv.token });
  const e3 = await S.wait('error', 2000, S.msgs.length - 1);
  ok(!!e3, '已關閉房間的邀請不能再使用');

  [A, B, B2, S, bad].forEach(c => c.close());
  console.log('\n結果：' + pass + ' 通過、' + failN + ' 失敗');
  srv.server.close(); process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
