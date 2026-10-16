/* ===== server.js — 靜態檔案 ＋ 房間伺服器（零依賴）=====
 * 靜態檔案用 Node 內建 http，連線用自己寫的 lib/ws.js（原生 WebSocket），
 * 整個專案不需要 npm install，雙擊 .bat 就能玩，丟到 Render 也一樣。
 *
 * 分工：
 *   lib/rooms.js       房間、席位、觀戰、邀請、聊天、回合制對局（純邏輯，不碰 socket）
 *   lib/match-loop.js  計時迴圈、廣播、心跳掃描
 *   lib/protocol.js    客戶端訊息 → 上面兩支的呼叫
 *   這一支              只負責 HTTP、WebSocket 與身分（誰是誰；同一個瀏覽器分頁斷線重連是同一個人）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ws = require('./lib/ws.js');
const { createHub } = require('./lib/rooms.js');
const { createLoop } = require('./lib/match-loop.js');
const { createProtocol } = require('./lib/protocol.js');

const PORT = Number(process.env.PORT) || 3160;
const ROOT = path.join(__dirname, 'public');
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const GAME_ID = 'pool-duel';
const ALIVE_MS = 2500;
const MILESTONE = 'M6';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json'
};

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('找不到這個檔案'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }

/** personId → { socket, person } */
const people = new Map();

const io = {
  send(personId, msg) { const it = people.get(personId); if (it && it.socket.alive) it.socket.sendJSON(msg); },
  lobbyIds() { const out = []; for (const [id, it] of people) if (!it.person.roomId && it.person.ready) out.push(id); return out; },
  aliveIds() {
    const now = Date.now(), out = [];
    for (const [id, it] of people) if (it.socket.alive && now - (it.socket.lastSeen || 0) < ALIVE_MS) out.push(id);
    return out;
  },
  pingAll() { for (const it of people.values()) it.socket.ping(); },
  /** 房間關了／被踢：這個人回到大廳狀態 */
  cleared(personId) { const it = people.get(personId); if (it) { it.person.roomId = null; it.person.role = null; } }
};

const hub = createHub();
const loop = createLoop(hub, io, { log: msg => console.log(msg) });
const proto = createProtocol(hub, loop, io);
loop.start();

function counts() {
  let players = 0, spectators = 0;
  for (const room of hub.rooms.values()) {
    players += hub.connectedSeats(room).length;
    spectators += hub.specsOf(room).filter(m => m.connected).length;
  }
  return { players, spectators };
}

const server = http.createServer((req, res) => {
  let url = '/';
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { url = '/'; }
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);

  if (url === '/api/presence') {
    const c = counts();
    json(res, 200, { gameId: GAME_ID, online: people.size, players: c.players, spectators: c.spectators, lobby: io.lobbyIds().length, rooms: hub.rooms.size, updatedAt: new Date().toISOString() });
    return;
  }
  if (url === '/api/rooms') { json(res, 200, { rooms: hub.listRooms(), seats: hub.CONST.SEATS }); return; }
  if (url === '/health') {
    const c = counts();
    json(res, 200, { ok: true, game: GAME_ID, milestone: MILESTONE, rooms: hub.rooms.size, players: c.players, spectators: c.spectators, online: people.size, kinds: hub.KINDS, time: Date.now() });
    return;
  }
  if (url === '/') url = '/index.html';
  const file = path.join(ROOT, path.normalize(url).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('不可以跑出 public 目錄'); return; }
  sendFile(res, file);
});

/* ---------- WebSocket ---------- */

/** clientId（瀏覽器分頁自己產生的祕密）→ 公開的 personId。斷線重連就是靠這個認出同一個人 */
const idFrom = clientId => 'p' + crypto.createHash('sha256').update('pool-duel|' + clientId).digest('hex').slice(0, 12);

ws.attach(server, {
  path: '/ws',
  onConnection(socket) {
    const person = { id: 'tmp' + crypto.randomBytes(5).toString('hex'), name: '', roomId: null, role: null, ready: false };
    people.set(person.id, { socket: socket, person: person });
    socket.data.person = person;
    socket.sendJSON({ type: 'hello', game: GAME_ID, milestone: MILESTONE });

    socket.on('message', text => {
      let msg = null;
      try { msg = JSON.parse(text); } catch (e) { return; }
      try {
        if (msg && msg.type === 'hello' && !person.ready) {
          const cid = String(msg.clientId || '').slice(0, 64);
          const newId = cid.length >= 8 ? idFrom(cid) : 'p' + crypto.randomBytes(6).toString('hex');
          const old = people.get(newId);
          people.delete(person.id);
          if (old && old.socket !== socket) {            // 同一個人從別的連線接手：舊連線直接關掉
            old.socket.data.replaced = true;
            try { old.socket.close(); } catch (e) { /* ignore */ }
          }
          person.id = newId; person.ready = true;
          people.set(newId, { socket: socket, person: person });
        }
        if (!person.ready) return;
        proto.handle(person, msg);
      } catch (e) {
        console.error('[proto] ' + (msg && msg.type) + ' 出錯：', e && e.stack || e);
        io.send(person.id, { type: 'error', text: 'err.server' });
      }
    });

    socket.on('close', () => {
      const it = people.get(person.id);
      if (!it || it.socket !== socket) return;           // 已經被新連線接手，不能把新連線判成斷線
      people.delete(person.id);
      console.log('[ws] 連線關閉：' + person.id + '（' + (person.name || '沒名字') + '）線上 ' + people.size + ' 人');
      if (!person.ready) return;
      hub.markDisconnected(person.id);
      if (person.roomId) { const room = hub.rooms.get(person.roomId); if (room) loop.sendRoom(room); }
      loop.pump();
      loop.sendLobby(true);
    });
  }
});

function localAddresses() {
  const out = [], nets = os.networkInterfaces();
  for (const name in nets) for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) out.push(net.address);
  return out;
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('撞球對決（pool-duel）已啟動');
    console.log('  本機：http://localhost:' + PORT);
    for (const ip of localAddresses()) console.log('  同網路：http://' + ip + ':' + PORT);
    console.log('  健康檢查：http://localhost:' + PORT + '/health');
  });
}

module.exports = { server, hub, loop, proto, io, people, PORT };
