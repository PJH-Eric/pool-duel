/* ===== lib/rooms.js — 房間、2 席位、觀戰、邀請、聊天、回合制對局 =====
 * 完全不碰 socket，可以直接寫測試。對局規則交給 public/js/rules.js（前後端同一套）。
 */
'use strict';

const Rules = require('../public/js/rules.js');
const P = require('../public/js/physics.js');
const Nicknames = require('../public/js/themes/nicknames.js');
const RNG = require('../public/js/rng.js');
const TURN = require('../public/js/turn-config.js');

const CONST = {
  MAX_ROOMS: 40,
  SEATS: 2,
  MAX_SPECTATORS: 20,
  CHAT_KEEP: 60,
  CHAT_MAX_LEN: 60,
  NAME_MAX_LEN: 12,
  HEARTBEAT_MS: 1000,
  DEAD_AFTER_MISSES: 2,
  RECONNECT_MS: 30000,      /* 對局中斷線保留 30 秒，逾時判負（§4.3） */
  CHOICE_MS: TURN.CHOICE_MS, /* 八號球的選擇視窗 */
  TURN_MS: TURN.TURN_MS,
  EXTENSION_MS: TURN.EXTENSION_MS,
  EXTENSIONS_PER_RACK: TURN.EXTENSIONS_PER_RACK,
  EMPTY_GRACE_MS: 60000,
  TICK_HZ: 10
};

const KINDS = ['nine', 'eight', 'score'];
const TURN_SECS = [TURN.TURN_MS / 1000];
const AIMS = ['full', 'short', 'off'];
const POCKETS = ['standard', 'big'];
const CUES = ['maple', 'ebony', 'blue', 'rosewood'];

let seq = 1;
const nextId = prefix => prefix + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

function token() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}
const clean = (text, max) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);

function createHub(opt) {
  opt = opt || {};
  const now = opt.now || (() => Date.now());
  const newSeed = opt.newSeed || (() => RNG.newSeed());
  const rooms = new Map();
  const invites = new Map();
  const events = [];                       /* 給 match-loop 取走並廣播 */

  const members = room => [...room.members.values()];
  const seatsOf = room => members(room).filter(m => m.role === 'player').sort((a, b) => a.seat - b.seat);
  const specsOf = room => members(room).filter(m => m.role === 'spectator');
  const connectedSeats = room => seatsOf(room).filter(m => m.connected);
  const seatMember = (room, seat) => seatsOf(room).find(m => m.seat === seat) || null;

  const hostNameOf = room => { const h = room.members.get(room.hostId); return h ? h.name : ''; };

  function freeSeat(room) {
    const used = new Set(seatsOf(room).map(m => m.seat));
    for (let i = 0; i < CONST.SEATS; i++) if (!used.has(i)) return i;
    return -1;
  }

  /* ---------- 房間生命週期 ---------- */

  function dropRoom(room, why) {
    if (!room || !rooms.has(room.id)) return false;
    if (room.invite) invites.delete(room.invite.token);
    room.invite = null;
    rooms.delete(room.id);
    events.push({ kind: 'closed', roomId: room.id, why: why || 'err.roomEnded', ids: members(room).filter(m => m.connected).map(m => m.id) });
    return true;
  }

  /** 還有「真人玩家」在（含對局中斷線、保留期內的人）才算房間還活著；只剩觀戰者就關（§5） */
  function hasLivePlayer(room) {
    return seatsOf(room).some(m => m.connected || (room.phase === 'playing' && m.dcAt && now() - m.dcAt < CONST.RECONNECT_MS));
  }

  function closeIfEmpty(room, grace) {
    if (!room || !rooms.has(room.id)) return false;
    if (hasLivePlayer(room)) { room.emptyAt = 0; return false; }
    if (grace && room.phase === 'lobby' && !members(room).some(m => m.connected)) {
      if (!room.emptyAt) room.emptyAt = now();
      return false;
    }
    return dropRoom(room, 'err.roomEnded');
  }

  function defaultCfg(cfg) {
    cfg = cfg || {};
    return {
      kind: KINDS.indexOf(cfg.kind) >= 0 ? cfg.kind : 'nine',
      turnSec: TURN.TURN_MS / 1000,
      aim: AIMS.indexOf(cfg.aim) >= 0 ? cfg.aim : 'full',
      pockets: POCKETS.indexOf(cfg.pockets) >= 0 ? cfg.pockets : 'standard'
    };
  }

  function createRoom(person, cfg) {
    cfg = cfg || {};
    if (rooms.size >= CONST.MAX_ROOMS) return { error: 'err.roomsFull' };
    const room = {
      id: nextId('r'),
      name: clean(cfg.name, 16),                /* 空字串＝用預設名稱（由前端依語言組「某某的房間」） */
      hostId: person.id,
      cfg: defaultCfg(cfg),
      phase: 'lobby',                 /* lobby | playing | result */
      members: new Map(),
      game: null,                     /* { state, seed, deadline, busyUntil } */
      round: 0,                       /* 對局識別：重連沿用，重玩遞增，不送到 GA4 */
      chat: [],
      invite: null,
      emptyAt: 0,
      createdAt: now()
    };
    rooms.set(room.id, room);
    const joined = join(room.id, person, 'player');
    if (joined.error) { rooms.delete(room.id); return joined; }
    return { room: room, role: 'player' };
  }

  function listRooms() {
    return [...rooms.values()]
      .filter(r => members(r).some(m => m.connected))
      .map(r => ({
        id: r.id, name: r.name, hostName: hostNameOf(r), kind: r.cfg.kind,
        players: connectedSeats(r).length, seats: CONST.SEATS,
        spectators: specsOf(r).filter(m => m.connected).length,
        phase: r.phase, hasInvite: !!r.invite
      }));
  }

  function join(roomId, person, wantRole) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'err.roomGone' };
    room.emptyAt = 0;
    const existing = room.members.get(person.id);
    if (existing) {
      existing.connected = true; existing.misses = 0; existing.dcAt = 0;
      return { room: room, role: existing.role, rejoined: true };
    }
    let role = wantRole === 'spectator' ? 'spectator' : 'player';
    if (role === 'player' && (freeSeat(room) < 0 || room.phase !== 'lobby')) role = 'spectator';
    if (role === 'spectator' && specsOf(room).filter(m => m.connected).length >= CONST.MAX_SPECTATORS) {
      return { error: 'err.specFull', params: { n: CONST.MAX_SPECTATORS } };
    }
    const m = {
      id: person.id, name: clean(person.name, CONST.NAME_MAX_LEN) || Nicknames.random(),
      role: role, seat: role === 'player' ? freeSeat(room) : -1,
      cue: CUES.indexOf(person.cue) >= 0 ? person.cue : 'maple',
      ready: false, again: false, connected: true, misses: 0, dcAt: 0, joinedAt: now()
    };
    room.members.set(person.id, m);
    if (!room.hostId || !room.members.has(room.hostId)) room.hostId = person.id;
    systemChat(room, role === 'player' ? 'sys.joinPlayer' : 'sys.joinSpec', { name: m.name });
    return { room: room, role: role };
  }

  function quickJoin(person) {
    const open = [...rooms.values()].find(r => r.phase === 'lobby' && connectedSeats(r).length < CONST.SEATS && freeSeat(r) >= 0);
    if (open) return join(open.id, person, 'player');
    return createRoom(person, {});
  }

  function passHost(room, leavingId) {
    if (room.hostId !== leavingId) return;
    const next = connectedSeats(room).find(m => m.id !== leavingId) || members(room).find(m => m.connected && m.id !== leavingId);
    room.hostId = next ? next.id : null;
    if (next) systemChat(room, 'sys.newHost', { name: next.name });
  }

  function leave(roomId, personId) {
    const room = rooms.get(roomId);
    if (!room) return { ok: true };
    const me = room.members.get(personId);
    if (!me) return { ok: true };
    if (room.phase === 'playing' && me.role === 'player') forfeitRoom(room, me.seat, 'forfeit');
    room.members.delete(personId);
    passHost(room, personId);
    systemChat(room, 'sys.left', { name: me.name || '' });
    closeIfEmpty(room);
    return { ok: true };
  }

  /** 連線斷了。對局中保留 30 秒（§4.3），其餘階段當作離開 */
  function markDisconnected(personId) {
    for (const room of [...rooms.values()]) {
      const me = room.members.get(personId);
      if (!me || !me.connected) continue;
      me.connected = false;
      if (room.phase === 'playing' && me.role === 'player') {
        me.dcAt = now();
        systemChat(room, 'sys.dcHold', { name: me.name });
        events.push({ kind: 'room', roomId: room.id });
        continue;
      }
      if (room.phase === 'lobby' || me.role === 'spectator') {
        room.members.delete(personId);
        systemChat(room, 'sys.offline', { name: me.name });
      } else systemChat(room, 'sys.offline', { name: me.name });
      passHost(room, personId);
      closeIfEmpty(room, true);
    }
  }

  /** 同一個人重新連上來：回到原席位（§4.3） */
  function reconnect(person) {
    for (const room of rooms.values()) {
      const me = room.members.get(person.id);
      if (me) {
        const wasDc = !me.connected;
        me.connected = true; me.misses = 0; me.dcAt = 0; room.emptyAt = 0;
        if (wasDc) { systemChat(room, 'sys.back', { name: me.name }); }
        // 重連後補一段回合時間，不讓人一回來就超時
        if (room.game && room.phase === 'playing' && room.game.deadline && room.game.deadline - now() < 8000) room.game.deadline = now() + 8000;
        return { room: room, role: me.role, rejoined: true };
      }
    }
    return null;
  }

  /* ---------- 房間設定與席位 ---------- */

  function updateRoom(roomId, hostId, c) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'err.roomGone' };
    if (room.hostId !== hostId) return { error: 'err.hostOnlyCfg' };
    if (room.phase !== 'lobby') return { error: 'err.cfgLocked' };
    const before = JSON.stringify(room.cfg);
    if (c.kind != null && KINDS.indexOf(c.kind) >= 0) room.cfg.kind = c.kind;
    if (c.aim != null && AIMS.indexOf(c.aim) >= 0) room.cfg.aim = c.aim;
    if (c.pockets != null && POCKETS.indexOf(c.pockets) >= 0) room.cfg.pockets = c.pockets;
    if (c.name != null) room.name = clean(c.name, 16) || room.name;
    if (JSON.stringify(room.cfg) !== before) {
      resetReady(room);
      systemChat(room, 'sys.cfg', { kind: room.cfg.kind });
    }
    return { room: room };
  }

  function setCue(roomId, personId, cue) {
    const room = rooms.get(roomId);
    if (!room || CUES.indexOf(cue) < 0) return { ok: false };
    const me = room.members.get(personId);
    if (me) me.cue = cue;
    return { ok: true, room: room };
  }

  function resetReady(room) { for (const m of room.members.values()) { m.ready = false; m.again = false; } }

  function setReady(roomId, personId, ready) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'err.roomGone' };
    const me = room.members.get(personId);
    if (!me || me.role !== 'player') return { error: 'err.playerOnlyReady' };
    me.ready = !!ready;
    return { room: room };
  }
  const allReady = room => { const s = connectedSeats(room); return s.length === CONST.SEATS && s.every(m => m.ready); };

  function takeSeat(roomId, personId) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'err.roomGone' };
    const me = room.members.get(personId);
    if (!me) return { error: 'err.notInRoom' };
    if (me.role === 'player') return { error: 'err.alreadyPlayer' };
    if (room.phase !== 'lobby') return { error: 'err.seatLater' };
    const seat = freeSeat(room);
    if (seat < 0) return { error: 'err.seatFull' };
    me.role = 'player'; me.seat = seat; me.ready = false;
    systemChat(room, 'sys.seated', { name: me.name });
    return { room: room, role: 'player' };
  }

  function kick(roomId, hostId, targetId) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'err.roomGone' };
    if (room.hostId !== hostId) return { error: 'err.hostOnlyKick' };
    if (targetId === hostId) return { error: 'err.kickSelf' };
    const t = room.members.get(targetId);
    if (!t) return { error: 'err.noSuchPerson' };
    if (room.phase === 'playing' && t.role === 'player') return { error: 'err.kickPlaying' };
    room.members.delete(targetId);
    systemChat(room, 'sys.kicked', { name: t.name });
    closeIfEmpty(room);
    return { room: room, kicked: targetId };
  }

  /* ---------- 邀請 ---------- */

  function makeInvite(roomId, hostId) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'err.roomGone' };
    if (room.hostId !== hostId) return { error: 'err.hostOnlyInvite' };
    if (room.invite) invites.delete(room.invite.token);
    const t = token();
    room.invite = { token: t, createdAt: now() };
    invites.set(t, room.id);
    return { token: t, roomId: room.id };
  }
  function revokeInvite(roomId, hostId) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'err.roomGone' };
    if (room.hostId !== hostId) return { error: 'err.hostOnlyRevoke' };
    if (room.invite) invites.delete(room.invite.token);
    room.invite = null;
    return { ok: true };
  }
  function resolveInvite(t) {
    const roomId = invites.get(String(t || ''));
    if (!roomId) return { error: 'err.inviteInvalid' };
    const room = rooms.get(roomId);
    if (!room) return { error: 'err.roomGone' };
    const full = freeSeat(room) < 0 || room.phase !== 'lobby';
    return { roomId: roomId, room: room, full: full };
  }

  /* ---------- 聊天 ---------- */

  function chat(roomId, personId, text) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'err.roomGone' };
    const me = room.members.get(personId);
    if (!me) return { error: 'err.notInRoom' };
    const body = clean(text, CONST.CHAT_MAX_LEN);
    if (!body) return { error: '' };
    push(room, { id: me.id, who: me.name, role: me.role, seat: me.seat, text: body, at: now() });
    return { room: room };
  }
  /* 系統訊息只存字典 key 與參數，由前端依目前語言翻譯 */
  function systemChat(room, key, params) { push(room, { sys: true, text: key, params: params || null, at: now() }); }
  function push(room, line) {
    room.chat.push(line);
    if (room.chat.length > CONST.CHAT_KEEP) room.chat.splice(0, room.chat.length - CONST.CHAT_KEEP);
  }

  /* ---------- 對局 ---------- */

  function rackRng(room) { return RNG.create(room.game.seed + '|' + room.game.state.rackNo + '|' + room.game.state.shotNo); }

  function setDeadline(room) {
    const g = room.game, s = g.state;
    if (s.phase === 'over') { g.deadline = 0; return; }
    if (s.phase === 'choice') { g.deadline = Math.max(now(), g.busyUntil) + CONST.CHOICE_MS; return; }
    g.deadline = Math.max(now(), g.busyUntil) + TURN.TURN_MS;
  }

  function beginGame(room, prevState) {
    room.round++;
    const seed = newSeed(room);
    const rng = RNG.create(seed + '|1|0');
    const opts = { bigPockets: room.cfg.pockets === 'big' };
    let state;
    if (prevState) state = Rules.nextGame(prevState, rng);
    else { opts.breaker = RNG.create(seed + '|b').next() < 0.5 ? 0 : 1; state = Rules.newGame(room.cfg.kind, opts, rng); }
    room.game = { state: state, seed: seed, deadline: 0, busyUntil: 0, extensionUsed: [false, false] };
    room.phase = 'playing';
    resetReady(room);
    setDeadline(room);
    const s = seatsOf(room);
    systemChat(room, 'sys.start', { kind: room.cfg.kind, name: s[state.breaker] ? s[state.breaker].name : '' });
  }

  function start(roomId, hostId) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'err.roomGone' };
    if (room.hostId !== hostId) return { error: 'err.hostOnlyStart' };
    if (room.phase !== 'lobby') return { error: 'err.alreadyStarted' };
    if (!allReady(room)) return { error: 'err.needReady' };
    beginGame(room, null);
    return { room: room };
  }

  function finishIfOver(room) {
    const s = room.game.state;
    if (s.phase === 'over') {
      room.phase = 'result';
      const m = seatsOf(room);
      const w = s.winner >= 0 && m[s.winner] ? m[s.winner].name : null;
      if (w) systemChat(room, 'sys.win', { name: w }); else systemChat(room, 'sys.draw');
      for (const x of room.members.values()) x.again = false;
    }
  }

  function actorSeat(room) {
    const s = room.game && room.game.state;
    if (!s) return -1;
    if (s.phase === 'choice' && s.pending) return s.pending.player;
    return s.turn;
  }

  /** 一桿：驗證 → 伺服器模擬 → 判定。回傳要廣播的 shot 與 settle 訊息 */
  function shot(roomId, personId, raw) {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'playing' || !room.game) return { error: 'err.noShotNow' };
    const me = room.members.get(personId);
    if (!me || me.role !== 'player') return { error: 'err.notPlayer' };
    const g = room.game, s = g.state;
    if (s.phase !== 'play') return { error: 'err.noShotNow' };
    if (me.seat !== s.turn) return { error: 'err.notYourTurn' };
    if (g.deadline && this_turnMs(room) <= 0) {
      const info = Rules.timeoutFoul(s);
      g.state = info.state; g.busyUntil = now();
      setDeadline(room);
      events.push({ kind: 'timeout', roomId: room.id, info: info });
      return { error: 'err.turnExpired', expired: true };
    }
    if (now() < g.busyUntil - 200) return { error: 'err.ballsRolling' };
    const sh = {
      ax: Number(raw && raw.ax), ay: Number(raw && raw.ay), power: Math.round(Number(raw && raw.power)),
      sx: Math.round(Number(raw && raw.sx) || 0), sy: Math.round(Number(raw && raw.sy) || 0)
    };
    if (raw && raw.jump) sh.jump = 1;
    if (raw && raw.cue && isFinite(raw.cue.x) && isFinite(raw.cue.y)) sh.cue = { x: Number(raw.cue.x), y: Number(raw.cue.y) };
    if (raw && raw.call != null) sh.call = Number(raw.call);
    if (raw && raw.cb != null) sh.cb = Number(raw.cb);
    if (raw && raw.safety) sh.safety = 1;
    if (raw && raw.boost != null) sh.boost = Number(raw.boost);
    const err = Rules.validateShot(s, sh);
    if (err) return { error: err };
    const w = Rules.prepareWorld(s, sh);
    w.recordEvents = false;
    P.applyShot(w, sh);
    const res = P.runToRest(w);
    const info = Rules.evaluateShot(s, sh, res);
    g.state = info.state;
    if (g.state.rackNo !== s.rackNo) g.extensionUsed = [false, false];
    const simMs = Math.ceil(res.t * 1000);
    g.busyUntil = now() + simMs;
    setDeadline(room);
    finishIfOver(room);
    return {
      shot: { type: 'shot', seat: me.seat, shot: sh, shotNo: s.shotNo + 1, simMs: simMs },
      settle: {
        type: 'settle', state: g.state, hash: res.hash, shotNo: g.state.shotNo,
        info: { player: info.player, fouls: info.fouls, pocketedObjects: info.pocketedObjects, scratch: info.scratch,
          continued: info.continued, notes: info.notes, eightLoss: info.eightLoss || null },
        turnMs: this_turnMs(room), phase: room.phase, extensionUsed: g.extensionUsed.slice(), rackNo: g.state.rackNo
      }
    };
  }
  function this_turnMs(room) {
    const g = room.game;
    return g && g.deadline ? Math.max(0, g.deadline - Math.max(now(), g.busyUntil)) : 0;
  }

  function extendTurn(roomId, personId) {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'playing' || !room.game) return { error: 'err.noExtendNow' };
    const me = room.members.get(personId);
    const g = room.game, s = g.state;
    if (!me || me.role !== 'player') return { error: 'err.extendPlayersOnly' };
    if (s.phase !== 'play' || me.seat !== s.turn) return { error: 'err.extendNotTurn' };
    if (now() < g.busyUntil) return { error: 'err.extendRolling' };
    if (this_turnMs(room) <= 0) return { error: 'err.extendExpired' };
    if (g.extensionUsed[me.seat]) return { error: 'err.extendUsed' };
    g.extensionUsed[me.seat] = true;
    g.deadline += TURN.EXTENSION_MS;
    return {
      type: 'extension', seat: me.seat, rackNo: s.rackNo, shotNo: s.shotNo,
      extensionUsed: g.extensionUsed.slice(), turnMs: this_turnMs(room)
    };
  }

  function choice(roomId, personId, c) {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'playing' || !room.game) return { error: 'err.noChoiceNow' };
    const me = room.members.get(personId);
    const g = room.game, s = g.state;
    if (s.phase !== 'choice' || !s.pending) return { error: 'err.noChoiceNow' };
    if (!me || me.seat !== s.pending.player) return { error: 'err.choiceNotYours' };
    if (this_turnMs(room) <= 0) {
      const r = applyChoice(room, Rules.defaultChoice(s), 'timeout');
      events.push({ kind: 'choice', roomId: room.id, r: r });
      return { error: 'err.choiceExpired', expired: true };
    }
    return applyChoice(room, c, 'player');
  }
  function applyChoice(room, c, who) {
    const g = room.game;
    const rackNo = g.state.rackNo;
    const r = Rules.resolveChoice(g.state, c, rackRng(room));
    if (r.error) return { error: r.error };
    g.state = r.state;
    if (g.state.rackNo !== rackNo) g.extensionUsed = [false, false];
    g.busyUntil = now();
    setDeadline(room);
    return { room: room, state: g.state, choice: r.choice, type: r.type, player: r.player, by: who };
  }

  function forfeitRoom(room, loserSeat, why) {
    if (!room.game || room.phase !== 'playing') return;
    room.game.state = Rules.forfeit(room.game.state, loserSeat, why === 'disconnect' ? 'disconnect' : 'forfeit');
    room.game.deadline = 0;
    const m = seatMember(room, loserSeat);
    systemChat(room, why === 'disconnect' ? 'sys.forfeitDc' : 'sys.forfeitLeft', { name: m ? m.name : '' });
    finishIfOver(room);
    events.push({ kind: 'state', roomId: room.id, forfeit: true });
    events.push({ kind: 'room', roomId: room.id });
  }

  function rematch(roomId, personId) {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'result') return { error: 'err.noRematch' };
    const me = room.members.get(personId);
    if (!me || me.role !== 'player') return { error: 'err.rematchPlayersOnly' };
    if (connectedSeats(room).length < CONST.SEATS) return { error: 'err.oppLeftRoom' };
    me.again = true;
    if (connectedSeats(room).every(m => m.again)) { beginGame(room, room.game.state); return { room: room, started: true }; }
    return { room: room };
  }

  function toLobby(roomId, personId) {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'result') return { error: 'err.noBackToRoom' };
    const me = room.members.get(personId);
    if (!me) return { error: 'err.notInRoom' };
    room.phase = 'lobby'; room.game = null; resetReady(room);
    // 已經離線的玩家席位釋出
    for (const m of [...room.members.values()]) if (!m.connected) room.members.delete(m.id);
    systemChat(room, 'sys.backRoom');
    if (!room.members.has(room.hostId)) passHost(room, room.hostId);
    return { room: room };
  }

  function heartbeat(personId) {
    for (const room of rooms.values()) { const me = room.members.get(personId); if (me) me.misses = 0; }
  }
  function sweepHeartbeats() {
    const dead = [];
    for (const room of rooms.values()) for (const me of room.members.values()) {
      if (!me.connected) continue;
      me.misses = (me.misses || 0) + 1;
      if (me.misses >= CONST.DEAD_AFTER_MISSES + 1) dead.push(me.id);
    }
    for (const id of dead) markDisconnected(id);
    return dead;
  }

  /** 計時：回合超時、斷線逾時、空房收掉 */
  function tick(dtMs) {
    const t = now();
    for (const room of [...rooms.values()]) {
      if (room.emptyAt && t - room.emptyAt >= CONST.EMPTY_GRACE_MS) { dropRoom(room, 'err.roomEnded'); continue; }
      if (room.phase === 'playing' && room.game) {
        let forfeited = false;
        for (const m of seatsOf(room)) {
          if (!m.connected && m.dcAt && t - m.dcAt >= CONST.RECONNECT_MS) {
            forfeitRoom(room, m.seat, 'disconnect'); forfeited = true; break;
          }
        }
        if (forfeited) { closeIfEmpty(room); continue; }
        const g = room.game;
        const actor = seatMember(room, actorSeat(room));
        if (actor && !actor.connected && g.deadline) g.deadline += dtMs;           /* 斷線期間暫停回合計時 */
        if (g.deadline && t >= g.deadline && t >= g.busyUntil) {
          if (g.state.phase === 'choice') {
            const r = applyChoice(room, Rules.defaultChoice(g.state), 'timeout');
            events.push({ kind: 'choice', roomId: room.id, r: r });
          } else {
            const info = Rules.timeoutFoul(g.state);
            g.state = info.state; g.busyUntil = t;
            setDeadline(room);
            events.push({ kind: 'timeout', roomId: room.id, info: info });
          }
        }
      }
      if (room.phase !== 'lobby') closeIfEmpty(room);
    }
  }

  /* ---------- 視圖 ---------- */

  function roomView(room, viewerId) {
    const me = room.members.get(viewerId);
    const dcm = seatsOf(room).find(m => !m.connected && m.dcAt);
    return {
      id: room.id, name: room.name, hostName: hostNameOf(room), hostId: room.hostId, isHost: room.hostId === viewerId,
      cfg: room.cfg, phase: room.phase,
      youAre: me ? me.role : null, youSeat: me ? me.seat : -1,
      seats: CONST.SEATS, maxSpectators: CONST.MAX_SPECTATORS,
      canTakeSeat: !!me && me.role === 'spectator' && room.phase === 'lobby' && freeSeat(room) >= 0,
      canStart: room.hostId === viewerId && room.phase === 'lobby' && allReady(room),
      invite: room.invite ? room.invite.token : null,
      members: members(room).map(m => ({
        id: m.id, name: m.name, role: m.role, seat: m.seat, cue: m.cue, ready: m.ready, again: m.again,
        connected: m.connected, host: m.id === room.hostId
      })),
      dc: dcm ? { id: dcm.id, seat: dcm.seat, ms: Math.max(0, CONST.RECONNECT_MS - (now() - dcm.dcAt)) } : null,
      chat: room.chat.slice(-30)
    };
  }

  function gameView(room) {
    const g = room.game;
    if (!g) return null;
    return {
      kind: room.cfg.kind, cfg: room.cfg, state: g.state, roundId: room.round,
      seats: [0, 1].map(i => { const m = seatMember(room, i); return m ? { id: m.id, name: m.name, cue: m.cue } : { id: null, name: '', cue: 'maple' }; }),
      turnMs: this_turnMs(room), busyMs: Math.max(0, g.busyUntil - now()), phase: room.phase,
      extensionUsed: g.extensionUsed.slice(), rackNo: g.state.rackNo
    };
  }

  function drainEvents() { const out = events.slice(); events.length = 0; return out; }

  return {
    rooms, invites, CONST, KINDS, TURN_SECS,
    createRoom, listRooms, join, quickJoin, leave, markDisconnected, reconnect, heartbeat, sweepHeartbeats,
    updateRoom, setReady, allReady, takeSeat, kick, setCue,
    makeInvite, revokeInvite, resolveInvite, chat, systemChat,
    start, shot, extendTurn, choice, rematch, toLobby, tick, roomView, gameView, drainEvents, closeIfEmpty,
    seatsOf, specsOf, connectedSeats, seatMember, actorSeat, dropRoom
  };
}

module.exports = { createHub, CONST, KINDS };
