/* ===== lib/protocol.js — 線上模式的訊息協定 =====
 * 客戶端能做的每一件事都在這裡收；故意跟 socket 分開，測試可以直接餵訊息。
 * 原則：伺服器權威。客戶端只送「出桿參數」，結果由伺服器用同一份物理引擎算出。
 */
'use strict';

const Nicknames = require('../public/js/themes/nicknames.js');

const NAME_MAX = 8;
const clean = (t, max) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, max);

function createProtocol(hub, loop, io) {
  const fail = (person, text, code) => { io.send(person.id, { type: 'error', text: text, code: code || null }); return false; };

  function entered(person, res) {
    if (res.error) return fail(person, res.error);
    person.roomId = res.room.id;
    person.role = res.role;
    io.send(person.id, { type: 'joined', roomId: res.room.id, role: res.role, rejoined: !!res.rejoined, room: hub.roomView(res.room, person.id) });
    loop.sendRoom(res.room);
    if (res.room.game) loop.sendGame(res.room, person.id);
    loop.sendLobby(true);
    return true;
  }

  function myRoom(person) { return person.roomId ? (hub.rooms.get(person.roomId) || null) : null; }

  function dropRoom(person) {
    const room = myRoom(person);
    person.roomId = null; person.role = null;
    if (!room) return;
    hub.leave(room.id, person.id);
    if (hub.rooms.has(room.id)) { loop.sendRoom(room); if (room.game) loop.sendGame(room); }
    loop.pump();
    loop.sendLobby(true);
  }

  function handle(person, msg) {
    if (!msg || typeof msg.type !== 'string') return false;
    hub.heartbeat(person.id);
    const room = myRoom(person);

    switch (msg.type) {
      case 'hello': {
        person.name = clean(msg.name, NAME_MAX) || Nicknames.random();
        person.cue = ['maple', 'ebony', 'blue', 'rosewood'].indexOf(msg.cue) >= 0 ? msg.cue : 'maple';
        io.send(person.id, {
          type: 'welcome', personId: person.id, name: person.name,
          seats: hub.CONST.SEATS, maxSpectators: hub.CONST.MAX_SPECTATORS,
          chatMaxLen: hub.CONST.CHAT_MAX_LEN, nameMaxLen: NAME_MAX, reconnectMs: hub.CONST.RECONNECT_MS
        });
        const re = hub.reconnect(person);
        if (re) { const m = re.room.members.get(person.id); if (m) { m.name = person.name; m.cue = person.cue; } return entered(person, re); }
        loop.sendLobbyTo(person.id);
        return true;
      }
      case 'rename': {
        const name = clean(msg.name, NAME_MAX);
        if (!name) return fail(person, '暱稱不能空白');
        person.name = name;
        if (room && room.members.has(person.id)) { room.members.get(person.id).name = name; loop.sendRoom(room); if (room.game) loop.sendGame(room); }
        io.send(person.id, { type: 'me', name: person.name });
        return true;
      }
      case 'rooms': loop.sendLobbyTo(person.id); return true;
      case 'cue': {
        if (['maple', 'ebony', 'blue', 'rosewood'].indexOf(msg.cue) < 0) return false;
        person.cue = msg.cue;
        if (room) { hub.setCue(room.id, person.id, msg.cue); loop.sendRoom(room); if (room.game) loop.sendGame(room); }
        return true;
      }

      case 'create':
        if (room) dropRoom(person);
        return entered(person, hub.createRoom(person, { name: msg.name, kind: msg.kind, aim: msg.aim, pockets: msg.pockets }));
      case 'join':
        if (room && room.id !== msg.roomId) dropRoom(person);
        return entered(person, hub.join(msg.roomId, person, msg.role));
      case 'quick':
        if (room) dropRoom(person);
        return entered(person, hub.quickJoin(person));
      case 'leave':
        dropRoom(person);
        io.send(person.id, { type: 'left' });
        loop.sendLobbyTo(person.id);
        return true;

      case 'invite': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.makeInvite(room.id, person.id);
        if (r.error) return fail(person, r.error);
        loop.sendRoom(room);
        io.send(person.id, { type: 'invite', token: r.token, roomId: r.roomId });
        return true;
      }
      case 'invite:revoke': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.revokeInvite(room.id, person.id);
        if (r.error) return fail(person, r.error);
        loop.sendRoom(room);
        io.send(person.id, { type: 'invite', token: null });
        return true;
      }
      case 'invite:peek': {         /* 先看看這個邀請是哪個房間，不加入（邀請頁要先給人確認暱稱） */
        const r = hub.resolveInvite(msg.token);
        if (r.error) { io.send(person.id, { type: 'invite:info', ok: false, text: r.error }); return true; }
        io.send(person.id, { type: 'invite:info', ok: true, roomName: r.room.name, kindName: require('../public/js/rules.js').KIND_NAME[r.room.cfg.kind], full: r.full, phase: r.room.phase });
        return true;
      }
      case 'invite:resolve': {
        const r = hub.resolveInvite(msg.token);
        if (r.error) return fail(person, r.error, 'invite');
        if (msg.name != null) {
          const name = clean(msg.name, NAME_MAX);
          if (!name) return fail(person, '暱稱不能空白');
          person.name = name;
        }
        if (room && room.id !== r.roomId) dropRoom(person);
        const res = hub.join(r.roomId, person, r.full ? 'spectator' : 'player');
        const ok = entered(person, res);
        if (ok && r.full) io.send(person.id, { type: 'notice', text: '席位已滿或對局進行中，先幫你安排觀戰' });
        return ok;
      }

      case 'config': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.updateRoom(room.id, person.id, msg);
        if (r.error) return fail(person, r.error);
        loop.sendRoom(room); loop.sendLobby(true);
        return true;
      }
      case 'ready': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.setReady(room.id, person.id, msg.ready);
        if (r.error) return fail(person, r.error);
        loop.sendRoom(room);
        return true;
      }
      case 'seat': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.takeSeat(room.id, person.id);
        if (r.error) return fail(person, r.error);
        person.role = 'player';
        loop.sendRoom(room); loop.sendLobby(true);
        return true;
      }
      case 'kick': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.kick(room.id, person.id, msg.targetId);
        if (r.error) return fail(person, r.error);
        io.send(msg.targetId, { type: 'kicked' });
        if (io.cleared) io.cleared(msg.targetId);
        if (hub.rooms.has(room.id)) loop.sendRoom(room);
        loop.pump(); loop.sendLobby(true);
        return true;
      }

      case 'start': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.start(room.id, person.id);
        if (r.error) return fail(person, r.error);
        loop.sendRoom(room); loop.sendGame(room); loop.sendLobby(true);
        return true;
      }
      case 'shot': {
        if (!room) return false;
        const r = hub.shot(room.id, person.id, msg.shot);
        if (r.error) { fail(person, r.error, 'shot'); if (r.expired) loop.pump(); if (room.game) loop.sendGame(room, person.id); return false; }
        loop.broadcast(room, r.shot);
        loop.broadcast(room, r.settle);
        if (room.phase === 'result') { loop.sendRoom(room); loop.sendLobby(true); }
        return true;
      }
      case 'extend': {
        if (!room) return fail(person, '你不在房間裡', 'extension');
        const r = hub.extendTurn(room.id, person.id);
        if (r.error) return fail(person, r.error, 'extension');
        loop.broadcast(room, r);
        return true;
      }
      case 'choice': {
        if (!room) return false;
        const r = hub.choice(room.id, person.id, msg.choice);
        if (r.error) { fail(person, r.error, 'choice'); if (r.expired) loop.pump(); return false; }
        loop.broadcast(room, loop.stateMsg(room, { choice: { choice: r.choice, type: r.type, player: r.player, by: 'player' } }));
        return true;
      }
      case 'aim': {                 /* 球桿瞄準位置，轉給對手與觀戰者看（最多每 90ms 一次） */
        if (!room || !room.game || room.phase !== 'playing') return false;
        const me = room.members.get(person.id);
        if (!me || me.role !== 'player' || hub.actorSeat(room) !== me.seat) return false;
        const t = Date.now();
        if (person.lastAim && t - person.lastAim < 80) return false;
        person.lastAim = t;
        const x = Number(msg.x), y = Number(msg.y), p = Number(msg.p);
        if (![x, y, p].every(isFinite)) return false;
        const out = { type: 'aim', seat: me.seat, x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4, p: Math.max(0, Math.min(1, p)) };
        if (msg.cue && isFinite(msg.cue.x) && isFinite(msg.cue.y)) out.cue = { x: Number(msg.cue.x), y: Number(msg.cue.y) };
        loop.broadcast(room, out, person.id);
        return true;
      }
      case 'sync': { if (room && room.game) loop.sendGame(room, person.id); return true; }
      case 'rematch': {
        if (!room) return false;
        const r = hub.rematch(room.id, person.id);
        if (r.error) return fail(person, r.error);
        loop.sendRoom(room);
        if (r.started) { loop.sendGame(room); loop.sendLobby(true); }
        return true;
      }
      case 'tolobby': {
        if (!room) return false;
        const r = hub.toLobby(room.id, person.id);
        if (r.error) return fail(person, r.error);
        loop.broadcast(room, { type: 'lobby-return' });
        loop.sendRoom(room); loop.sendLobby(true);
        return true;
      }

      case 'chat': {
        if (!room) return fail(person, '你不在房間裡');
        const r = hub.chat(room.id, person.id, msg.text);
        if (r.error) return r.error ? fail(person, r.error) : false;
        loop.sendRoom(room);
        return true;
      }
      case 'hb': hub.heartbeat(person.id); return true;
      case 'ping':
        hub.heartbeat(person.id);
        io.send(person.id, { type: 'pong', t: msg.t, serverTime: Date.now() });
        return true;
      default: return false;
    }
  }

  return { handle, dropRoom, myRoom };
}

module.exports = { createProtocol, NAME_MAX };
