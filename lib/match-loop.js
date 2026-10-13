/* ===== lib/match-loop.js — 計時迴圈與廣播 =====
 * 撞球是回合制，不需要逐幀同步：這裡每 100ms 讓房間檢查一次計時（回合超時、斷線 30 秒、空房），
 * 每秒掃一次心跳，並把房間／對局狀態推給房裡每一個人（含觀戰者）。
 * 不碰 WebSocket：時鐘與送出都是注入進來的，測試可以用假時鐘。
 */
'use strict';

function createLoop(hub, io, opt) {
  opt = opt || {};
  const hz = opt.hz || hub.CONST.TICK_HZ;
  const tickMs = 1000 / hz;
  const now = opt.now || (() => Date.now());
  let last = null, acc = 0, hbAcc = 0, timer = null, ticks = 0;
  let lobbySig = '';

  function sendRoom(room) {
    for (const m of room.members.values()) if (m.connected) io.send(m.id, { type: 'room', room: hub.roomView(room, m.id) });
  }
  function sendGame(room, personId) {
    const g = hub.gameView(room);
    if (!g) return;
    const msg = { type: 'game', game: g };
    if (personId) io.send(personId, msg);
    else for (const m of room.members.values()) if (m.connected) io.send(m.id, msg);
  }
  function broadcast(room, msg, exceptId) {
    for (const m of room.members.values()) if (m.connected && m.id !== exceptId) io.send(m.id, msg);
  }
  function sendLobby(force) {
    const rooms = hub.listRooms();
    const sig = JSON.stringify(rooms);
    if (!force && sig === lobbySig) return;
    lobbySig = sig;
    const msg = { type: 'rooms', rooms: rooms };
    for (const id of io.lobbyIds()) io.send(id, msg);
  }
  function sendLobbyTo(personId) { io.send(personId, { type: 'rooms', rooms: hub.listRooms() }); }

  function stateMsg(room, extra) {
    const g = hub.gameView(room);
    return Object.assign({ type: 'state', state: g.state, turnMs: g.turnMs, phase: room.phase, extensionUsed: g.extensionUsed, rackNo: g.rackNo }, extra || {});
  }

  function pump() {
    for (const ev of hub.drainEvents()) {
      if (ev.kind === 'closed') {
        for (const id of ev.ids) { io.send(id, { type: 'closed', why: ev.why }); if (io.cleared) io.cleared(id); }
        sendLobby(true);
        continue;
      }
      const room = hub.rooms.get(ev.roomId);
      if (!room) continue;
      if (ev.kind === 'room') sendRoom(room);
      else if (ev.kind === 'state') { broadcast(room, stateMsg(room, { forfeit: !!ev.forfeit })); sendRoom(room); }
      else if (ev.kind === 'timeout') {
        broadcast(room, stateMsg(room, { info: { player: ev.info.player, fouls: ['timeout'], pocketedObjects: [], scratch: false, continued: false, notes: [] } }));
        sendRoom(room);
      } else if (ev.kind === 'choice') {
        if (ev.r && ev.r.state) broadcast(room, stateMsg(room, { choice: { choice: ev.r.choice, type: ev.r.type, player: ev.r.player, by: 'timeout' } }));
        sendRoom(room);
      }
    }
    sendLobby();
  }

  function frame(nowMs) {
    const t = nowMs == null ? now() : nowMs;
    if (last == null) { last = t; return 0; }
    let dt = t - last; last = t;
    if (dt < 0) dt = 0;
    if (dt > 5000) dt = 5000;
    acc += dt; hbAcc += dt;
    let ran = 0;
    while (acc >= tickMs) { acc -= tickMs; ticks++; hub.tick(tickMs); pump(); ran++; if (ran > 60) { acc = 0; break; } }
    while (hbAcc >= hub.CONST.HEARTBEAT_MS) { hbAcc -= hub.CONST.HEARTBEAT_MS; heartbeatRound(); }
    return ran;
  }

  function heartbeatRound() {
    if (io.aliveIds) for (const id of io.aliveIds()) hub.heartbeat(id);
    const dead = hub.sweepHeartbeats();
    if (dead.length) {
      if (opt.log) opt.log('[hb] 心跳連續沒回，判定離線：' + dead.join(', '));
      for (const room of hub.rooms.values()) sendRoom(room);
      pump(); sendLobby(true);
    }
    const asked = new Set();
    for (const room of hub.rooms.values()) for (const m of room.members.values()) {
      if (m.connected && !asked.has(m.id)) { asked.add(m.id); io.send(m.id, { type: 'hb' }); }
    }
    for (const id of io.lobbyIds()) if (!asked.has(id)) io.send(id, { type: 'hb' });
    if (io.pingAll) io.pingAll();
    // 倒數中的斷線資訊每秒刷新一次，客戶端自己倒數、這裡只負責校正
    for (const room of hub.rooms.values()) if (room.phase === 'playing' && hub.seatsOf(room).some(m => !m.connected && m.dcAt)) sendRoom(room);
    return dead;
  }

  function start() { if (timer) return; last = now(); timer = setInterval(() => frame(now()), tickMs); if (timer.unref) timer.unref(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return {
    hz: hz, tickMs: tickMs, frame, start, stop, heartbeatRound, pump,
    sendRoom, sendGame, broadcast, sendLobby, sendLobbyTo, stateMsg,
    stats: () => ({ ticks: ticks, rooms: hub.rooms.size })
  };
}

module.exports = { createLoop };
