/* 線上：大廳、房間、邀請、聊天、斷線重連畫面。訊息來自 online.js（Net），對局本身交給 PoolGame。 */
(function (root) {
  'use strict';
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const Net = root.Net, Store = root.Store, Sound = root.Sound, Nick = root.Nicknames;
  const T = (k, p) => root.I18N.t(k, p), SRV = (s, p) => root.I18N.srv(s, p);
  /* 房間顯示名：房主有取名就用，否則依語言組預設名稱 */
  const roomName = r => r.name || T('room.defaultName', { name: r.hostName || T('seat.opp') });
  /* 聊天室的系統訊息：伺服器只送 key 與參數 */
  const sysText = c => { const p = Object.assign({}, c.params || {}); if (p.kind) p.kind = T('kindFull.' + p.kind); if ('name' in p && !p.name) p.name = T('seat.opp'); return SRV(c.text, p); };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const firstChar = n => Array.from(String(n || '?'))[0] || '?';
  const QUICK = [1, 2, 3, 4, 5, 6, 7];
  const L = {
    room: null, rooms: [], pendingInvite: null, awaitJoin: 0, wasInRoom: false, lastChatAt: 0, dcEnd: 0, dcTimer: 0,
    create: { kind: 'nine', aim: 'full', pockets: 'standard' },
    inGame: false, status: null, recon: null, inviteInfo: null
  };
  root.PoolLobby = L;

  function app() { return root.PoolApp; }
  function myName() { return Store.get('nickname') || ''; }

  L.init = function () {
    if (!Store.get('nickname')) Store.set('nickname', Nick.random());
    $('#nickInput').value = Store.get('nickname');
    $('#nickInput').addEventListener('change', commitNick);
    $('#nickInput').addEventListener('keydown', e => { if (e.key === 'Enter') { commitNick(); e.target.blur(); } });
    $('#btnNickRandom').onclick = () => { $('#nickInput').value = Nick.random(); commitNick(); };
    $('#btnQuick').onclick = () => { commitNick(); Net.send({ type: 'quick' }) || app().toast(T('toast.notConnected')); };
    $('#btnCreateToggle').onclick = () => { $('#createBox').classList.toggle('hidden'); buildCreateForm(); };
    $('#btnCreate').onclick = () => { commitNick(); Net.send(Object.assign({ type: 'create' }, L.create)); $('#createBox').classList.add('hidden'); };
    $('#roomBack').onclick = () => L.leaveRoom();
    $('#btnReady').onclick = () => { const me = myMember(); if (me) Net.send({ type: 'ready', ready: !me.ready }); };
    $('#btnStartRoom').onclick = () => Net.send({ type: 'start' });
    $('#btnTakeSeat').onclick = () => Net.send({ type: 'seat' });
    buildQuick();
    $$('[data-chatform]').forEach(f => f.addEventListener('submit', e => { e.preventDefault(); const i = f.querySelector('input'); const t = i.value.trim(); if (t) Net.send({ type: 'chat', text: t }); i.value = ''; }));
    const q = new URLSearchParams(location.search).get('invite');
    if (q) { L.pendingInvite = q; L.enter(); }
  };
  function buildQuick() {
    $$('[data-quick]').forEach(box => { box.innerHTML = ''; QUICK.forEach(n => { const t = T('quick.' + n); const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = t; b.onclick = () => Net.send({ type: 'chat', text: t }); box.appendChild(b); }); });
  }
  function commitNick() {
    let v = $('#nickInput').value.replace(/\s+/g, ' ').trim().slice(0, 12);
    if (!v) v = Store.get('nickname') || Nick.random();
    $('#nickInput').value = v; Store.set('nickname', v);
    Net.name = v; if (Net.status === 'open') Net.send({ type: 'rename', name: v });
  }
  L.enter = function () {
    app().show('lobby'); buildCreateForm(); renderRooms();
    if (!Net.enabled) { setStatus('lobby.soloOnly', 'warn'); return; }
    Net.connect(Store.get('nickname'));
    if (Net.status === 'open') { Net.send({ type: 'rooms' }); setStatus('lobby.connected', 'ok'); if (L.pendingInvite) peekInvite(); }
  };
  L.leaveRoom = function (toHome) {
    Net.send({ type: 'leave' });
    L.room = null; L.wasInRoom = false;
    if (app().game) app().game.stop();
    app().show(toHome ? 'home' : 'lobby');
    $('#resultOverlay').classList.add('hidden');
  };
  /* key 是字典 key（空字串＝隱藏）；保留 key 與參數，切換語言時可以重繪 */
  function setStatus(key, kind, params) { L.status = key ? { key, kind, params } : null; paintStatus(); }
  function paintStatus() { const el = $('#lobbyStatus'), st = L.status; el.textContent = st ? T(st.key, st.params) : ''; el.className = 'status-pill' + (st && st.kind ? ' ' + st.kind : ''); el.classList.toggle('hidden', !st); }
  const myMember = () => L.room && L.room.members.find(m => m.id === Net.personId);

  /* ---------- 連線事件 ---------- */
  Net.on('status', s => {
    if (s.status === 'open') { setStatus('lobby.connected', 'ok'); setTimeout(() => { if (Net.status === 'open' && !L.room) setStatus(''); }, 1800); }
    else if (s.key) setStatus(s.key, s.status === 'failed' ? 'warn' : '', s.params);
    const ov = $('#reconnectOverlay');
    if (s.status === 'retrying' || s.status === 'waking' || s.status === 'connecting') { if (L.wasInRoom) { ov.classList.remove('hidden'); setRecon(s.key || 'net.reconnecting', s.params); } }
    if (s.status === 'failed' && L.wasInRoom) { ov.classList.add('hidden'); roomLost(T('toast.lostServer')); }
  });
  Net.on('welcome', m => {
    $('#nickInput').value = m.name; Store.set('nickname', m.name);
    if (L.pendingInvite) peekInvite();
    if (L.wasInRoom) { clearTimeout(L.awaitJoin); L.awaitJoin = setTimeout(() => { if (L.wasInRoom) roomLost(T('toast.roomGone')); }, 1500); }
  });
  function setRecon(key, params) { L.recon = { key, params }; $('#reconnectText').textContent = T(key, params); }
  function roomLost(text) {
    L.room = null; L.wasInRoom = false; $('#reconnectOverlay').classList.add('hidden'); $('#resultOverlay').classList.add('hidden');
    if (app().game) app().game.stop();
    app().toast(text); app().show('lobby'); setStatus('');
    if (Net.status === 'open') Net.send({ type: 'rooms' });
  }
  Net.on('rooms', m => { L.rooms = m.rooms; renderRooms(); });
  Net.on('error', m => {
    if (m.code === 'invite') showInviteError(m.text, m.params);
    else {
      if (m.code === 'extension' && app().game && app().game.cfg && app().game.cfg.mode === 'online') app().game.extensionRejected();
      app().toast(m.text ? SRV(m.text, m.params) : T('toast.error'));
    }
  });
  Net.on('notice', m => app().toast(SRV(m.text, m.params)));
  Net.on('joined', m => {
    clearTimeout(L.awaitJoin); $('#reconnectOverlay').classList.add('hidden');
    L.room = m.room; L.wasInRoom = true; L.inGame = false;
    if (L.pendingInvite) { L.pendingInvite = null; $('#inviteLanding').classList.add('hidden'); try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } }
    if (m.rejoined && (m.room.phase !== 'lobby')) app().toast(T('toast.rejoined'));
    if (m.room.phase === 'lobby') { app().show('room'); renderRoom(); }
    // 對局中進來／重連：接下來會收到 game 訊息
  });
  Net.on('room', m => {
    const first = !L.room; const prevChatAt = L.lastChatAt;
    L.room = m.room;
    renderRoom(); renderChats(); updateDc();
    if (root.PoolApp.updateRematch) root.PoolApp.updateRematch(m.room);
    const g = app().game;
    if (g && g.cfg && g.cfg.mode === 'online' && g.state) {
      const seats = [0, 1].map(i => { const mm = m.room.members.find(x => x.role === 'player' && x.seat === i); return mm ? { name: mm.name } : { name: '空位', key: 'seat.empty' }; });
      g.setSeatNames(seats);
      if (g.cfg) g.cfg.aimMode = m.room.cfg.aim;
    }
    const ch = m.room.chat; const last = ch.length ? ch[ch.length - 1].at : 0;
    if (last > prevChatAt && prevChatAt) { const lastMsg = ch[ch.length - 1]; if (!lastMsg.sys && lastMsg.id !== Net.personId) { Sound.sfx.chat(); app().addUnread(); } }
    L.lastChatAt = last;
  });
  Net.on('game', m => {
    const g = app().game;
    if (g && g.cfg && g.cfg.mode === 'online' && app().screen === 'game' && g.running) { g.onNet(m); return; }
    if (!L.room) return;
    $('#reconnectOverlay').classList.add('hidden');
    app().startOnlineGame(m.game, L.room);
    L.inGame = true;
  });
  ['shot', 'settle', 'state', 'aim', 'extension'].forEach(t => Net.on(t, m => { const g = app().game; if (g && g.cfg && g.cfg.mode === 'online') g.onNet(m); if (t === 'state' || t === 'settle') { const rm = L.room; if (rm && m.phase) rm.phase = m.phase; } }));
  Net.on('lobby-return', () => { $('#resultOverlay').classList.add('hidden'); if (app().game) app().game.stop(); if (L.room) { app().show('room'); renderRoom(); } });
  Net.on('closed', m => { const why = SRV(m.why || 'err.roomEnded'); app().toast(why); roomLost(why); });
  Net.on('kicked', () => roomLost(T('toast.kicked')));
  Net.on('left', () => { /* leaveRoom 已處理 */ });
  Net.on('invite', m => { if (L.room) { L.room.invite = m.token; renderInvite(); } });
  Net.on('invite:info', m => showInviteInfo(m));
  Net.on('dropped', () => { if (L.wasInRoom) { $('#reconnectOverlay').classList.remove('hidden'); setRecon('net.dropped'); } });

  /* ---------- 邀請 ---------- */
  function peekInvite() { if (L.pendingInvite) { setTimeout(() => Net.send({ type: 'invite:peek', token: L.pendingInvite }), 50); $('#inviteLanding').classList.remove('hidden'); $('#inviteLanding').innerHTML = '<p class="note">' + esc(T('invite.checking')) + '</p>'; } }
  function showInviteInfo(m) {
    L.inviteInfo = m;
    const box = $('#inviteLanding'); box.classList.remove('hidden');
    if (!m.ok) { box.innerHTML = '<h3 class="sec tight">' + esc(T('invite.title')) + '</h3><p class="res-reason">' + esc(SRV(m.text, m.params)) + '</p><button class="btn small" id="invDismiss">' + esc(T('common.gotIt')) + '</button>'; $('#invDismiss').onclick = () => { L.pendingInvite = null; L.inviteInfo = null; box.classList.add('hidden'); try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } }; return; }
    box.innerHTML = '<h3 class="sec tight">' + esc(T('invite.friend')) + '</h3><p class="res-reason" style="margin:0 0 10px">' + esc(T('invite.room', { name: roomName({ name: m.roomName, hostName: m.hostName }), kind: T('kindFull.' + m.kind) })) + (m.full ? '<br>' + T('invite.fullNote') : '') + '<br>' + esc(T('invite.confirmNick')) + '</p><button class="btn gold" id="invJoin">' + esc(m.full ? T('invite.joinSpec') : T('invite.joinRoom')) + '</button>';
    $('#invJoin').onclick = () => { commitNick(); Net.send({ type: 'invite:resolve', token: L.pendingInvite, name: Store.get('nickname') }); };
  }
  function showInviteError(text, params) { L.inviteInfo = { ok: false, text, params }; const box = $('#inviteLanding'); box.classList.remove('hidden'); box.innerHTML = '<h3 class="sec tight">' + esc(T('invite.title')) + '</h3><p class="res-reason">' + esc(SRV(text, params)) + '</p>'; L.pendingInvite = null; }

  /* ---------- 大廳 ---------- */
  function seg(el, opts, cur, onPick) {
    el.innerHTML = '';
    opts.forEach(o => { const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-b'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(o[0]) === String(cur) ? 'true' : 'false'); b.textContent = T(o[1]); b.onclick = () => onPick(o[0]); el.appendChild(b); });
  }
  const OPT = {
    kind: [['nine', 'opt.kind.nine'], ['eight', 'opt.kind.eight'], ['score', 'opt.kind.score']],
    aim: [['full', 'opt.aim.full'], ['short', 'opt.aim.short'], ['off', 'opt.aim.off']],
    pockets: [['standard', 'opt.pockets.standard'], ['big', 'opt.pockets.big']]
  };
  const LABEL = { kind: 'lbl.kind', aim: 'lbl.aim', pockets: 'lbl.pockets' };
  function buildCreateForm() {
    const f = $('#createForm'); f.innerHTML = '';
    Object.keys(OPT).forEach(k => {
      const lb = document.createElement('span'); lb.className = 'lbl'; lb.textContent = T(LABEL[k]); const sg = document.createElement('div'); sg.className = 'seg'; sg.setAttribute('role', 'radiogroup'); sg.setAttribute('aria-label', T(LABEL[k]));
      seg(sg, OPT[k], L.create[k], v => { L.create[k] = v; buildCreateForm(); });
      f.appendChild(lb); f.appendChild(sg);
    });
    addFixedTurnRow(f);
  }
  function renderRooms() {
    const box = $('#roomList');
    if (!L.rooms.length) { box.innerHTML = '<div class="empty">' + T('lobby.empty') + '</div>'; return; }
    box.innerHTML = '';
    L.rooms.forEach(r => {
      const row = document.createElement('div'); row.className = 'room-row';
      const canPlay = r.players < r.seats && r.phase === 'lobby';
      row.innerHTML = '<div class="grow"><div class="rn">' + esc(roomName(r)) + '</div><div class="rm">' + esc(T('kindFull.' + r.kind)) + T('common.dot') + esc(T('lobby.players', { p: r.players, s: r.seats })) + (r.spectators ? T('common.dot') + esc(T('lobby.watchers', { n: r.spectators })) : '') + T('common.dot') + esc(r.phase === 'lobby' ? T('lobby.waiting') : T('lobby.playing')) + '</div></div>';
      const b = document.createElement('button'); b.className = 'btn small' + (canPlay ? ' gold' : ''); b.textContent = canPlay ? T('lobby.join') : T('lobby.watch');
      b.onclick = () => { commitNick(); Net.send({ type: 'join', roomId: r.id, role: canPlay ? 'player' : 'spectator' }); };
      row.appendChild(b); box.appendChild(row);
    });
  }

  /* ---------- 房間 ---------- */
  function renderRoom() {
    const r = L.room; if (!r || app().screen !== 'room') return;
    $('#roomTitle').textContent = roomName(r);
    const players = [0, 1].map(i => r.members.find(m => m.role === 'player' && m.seat === i));
    $('#seatCards').innerHTML = players.map((m, i) => {
      if (!m) return '<div class="seat-card empty-seat"><div class="avatar sp">？</div><div class="nm">' + esc(T('seat.empty')) + '</div><div class="st">' + esc(T('room.waitFriend')) + '</div></div>';
      const mine = m.id === Net.personId;
      return '<div class="seat-card' + (mine ? ' mine' : '') + '"><div class="avatar s' + i + '">' + esc(firstChar(m.name)) + '</div><div class="nm">' + esc(m.name) + (mine ? esc(T('room.you')) : '') + (m.host ? ' ★' : '') + '</div><div class="st ' + (m.ready ? 'ready' : '') + '">' + esc(m.connected ? (m.ready ? T('room.stReady') : T('room.stNotReady')) : T('room.stOffline')) + '</div></div>';
    }).join('');
    const specs = r.members.filter(m => m.role === 'spectator');
    $('#specCount').textContent = specs.length + '/' + r.maxSpectators;
    $('#specList').innerHTML = specs.length ? specs.map(m => '<span class="spec"><i class="dc-dot' + (m.connected ? '' : ' off') + '"></i>' + esc(m.name) + (m.id === Net.personId ? esc(T('room.you')) : '') + (r.isHost && m.id !== Net.personId ? ' <button class="btn small kick-btn" data-kick="' + m.id + '">' + esc(T('room.kick')) + '</button>' : '') + '</span>').join('') : '<span class="note">' + esc(T('room.noSpec')) + '</span>';
    $$('[data-kick]').forEach(b => b.onclick = () => Net.send({ type: 'kick', targetId: b.dataset.kick }));
    // 設定
    const cfg = $('#roomCfg'); cfg.innerHTML = '<h3 class="sec tight">' + esc(T('room.cfgTitle')) + (r.isHost ? '' : esc(T('room.cfgGuest'))) + '</h3>';
    Object.keys(OPT).forEach(k => {
      const row = document.createElement('div'); row.className = 'cfg-row'; row.innerHTML = '<span class="lbl">' + esc(T(LABEL[k])) + '</span>';
      if (r.isHost) { const sg = document.createElement('div'); sg.className = 'seg'; sg.setAttribute('role', 'radiogroup'); sg.setAttribute('aria-label', T(LABEL[k])); seg(sg, OPT[k], r.cfg[k], v => Net.send({ type: 'config', [k]: v })); row.appendChild(sg); }
      else { const vk = (OPT[k].find(o => String(o[0]) === String(r.cfg[k])) || [0, ''])[1]; const sp = document.createElement('span'); sp.className = 'cfg-val'; sp.textContent = vk ? T(vk) : ''; row.appendChild(sp); }
      cfg.appendChild(row);
    });
    addFixedTurnRow(cfg);
    renderInvite();
    const me = myMember();
    $('#btnTakeSeat').classList.toggle('hidden', !r.canTakeSeat);
    $('#btnReady').classList.toggle('hidden', !(me && me.role === 'player'));
    if (me) { $('#btnReady').textContent = me.ready ? T('room.unready') : T('room.ready'); $('#btnReady').classList.toggle('green', !me.ready); }
    $('#btnStartRoom').classList.toggle('hidden', !r.isHost); $('#btnStartRoom').disabled = !r.canStart;
    let hint = '';
    if (me && me.role === 'spectator') hint = T('room.hintSpec');
    else if (players.filter(Boolean).length < 2) hint = T('room.hintWait');
    else if (!r.isHost) hint = me && me.ready ? T('room.hintReadyGuest') : T('room.hintPress');
    else hint = r.canStart ? T('room.hintCanStart') : T('room.hintNeedReady');
    $('#roomHint').textContent = hint;
    $('#roomDc').classList.toggle('hidden', !r.dc);
  }
  function addFixedTurnRow(container) {
    const row = document.createElement('div'); row.className = 'fixed-turn-row';
    const label = document.createElement('span'); label.className = 'lbl'; label.textContent = T('room.turnTime');
    const value = document.createElement('div'); value.className = 'cfg-val';
    const time = document.createElement('span'); time.className = 'fixed-turn-time'; time.textContent = T('room.turnValue');
    const detail = document.createElement('span'); detail.className = 'fixed-turn-detail'; detail.textContent = T('room.extOnce');
    const extension = document.createElement('span'); extension.className = 'fixed-turn-extension'; extension.textContent = T('room.extPlus');
    detail.appendChild(extension); value.appendChild(time); value.appendChild(detail);
    row.appendChild(label); row.appendChild(value); container.appendChild(row);
  }
  function inviteUrl(token) {
    let u = location.origin + location.pathname + '?invite=' + encodeURIComponent(token);
    if (root.Config && root.Config.source === 'query' && root.Config.serverUrl) u += '&server=' + encodeURIComponent(root.Config.serverUrl);
    return u;
  }
  function renderInvite() {
    const r = L.room, box = $('#inviteBox'); if (!r) return;
    if (!r.isHost) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if (!r.invite) { box.innerHTML = '<h3 class="sec tight">' + esc(T('invite.title')) + '</h3><p class="note" style="margin-bottom:10px">' + esc(T('invite.hint')) + '</p><button class="btn small gold" id="btnMkInvite">' + esc(T('invite.make')) + '</button>'; $('#btnMkInvite').onclick = () => Net.send({ type: 'invite' }); return; }
    const url = inviteUrl(r.invite);
    box.innerHTML = '<h3 class="sec tight">' + esc(T('invite.title')) + '</h3><div class="invite-row"><input class="field selectable" readonly value="' + esc(url) + '" aria-label="' + esc(T('invite.title')) + '"><button class="btn small gold" id="btnCopyInvite">' + esc(T('invite.copy')) + '</button></div><div class="row wrap" style="margin-top:10px"><button class="btn small ghost" id="btnReInvite">' + esc(T('invite.renew')) + '</button><button class="btn small ghost" id="btnRevoke">' + esc(T('invite.revoke')) + '</button></div>';
    $('#btnCopyInvite').onclick = () => copy(url);
    $('#btnReInvite').onclick = () => Net.send({ type: 'invite' });
    $('#btnRevoke').onclick = () => Net.send({ type: 'invite:revoke' });
  }
  function copy(text) {
    const done = () => app().toast(T('toast.copied'));
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    function fallback() { const i = $('#inviteBox input'); if (i) { i.select(); try { document.execCommand('copy'); done(); } catch (e) { app().toast(T('toast.copyManual')); } } }
  }

  /* ---------- 聊天 ---------- */
  function renderChats() {
    const r = L.room; if (!r) return;
    const html = r.chat.map(c => c.sys ? '<div class="msg sys">' + esc(sysText(c)) + '</div>' :
      '<div class="msg' + (c.id === Net.personId ? ' me' : '') + '"><span class="who">' + esc(c.who) + (c.role === 'spectator' ? esc(T('chat.spectator')) : '') + '</span>' + esc(c.text) + '</div>').join('');
    ['#roomChat', '#gChat'].forEach(sel => { const el = $(sel); const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40; el.innerHTML = html; if (atBottom || true) el.scrollTop = el.scrollHeight; });
  }

  /* ---------- 斷線倒數 ---------- */
  function updateDc() {
    const r = L.room, banner = $('#dcBanner'), roomDc = $('#roomDc');
    clearInterval(L.dcTimer);
    if (!r || !r.dc || r.phase !== 'playing') { banner.classList.add('hidden'); return; }
    const who = r.members.find(m => m.id === r.dc.id); const name = who ? who.name : T('seat.opp');
    L.dcEnd = performance.now() + r.dc.ms;
    const paint = () => {
      const sec = Math.max(0, Math.ceil((L.dcEnd - performance.now()) / 1000));
      const mine = myMember() && myMember().role === 'player';
      banner.textContent = T(mine ? 'room.dcPlayer' : 'room.dcSpec', { name, sec });
    };
    banner.classList.remove('hidden'); paint(); L.dcTimer = setInterval(paint, 500);
  }

  /* 語言切換：自動產生的暱稱換成對應語言，並重繪大廳／房間／聊天等動態文字 */
  function isRoomVisible() { return app() && app().screen === 'room'; }
  L.relocalize = function () {
    const cur = Store.get('nickname');
    if (cur && Nick.isAuto && Nick.isAuto(cur)) {
      const nn = Nick.random(); $('#nickInput').value = nn; Store.set('nickname', nn); Net.name = nn;
      if (Net.status === 'open') Net.send({ type: 'rename', name: nn });
    }
    buildQuick(); paintStatus(); renderRooms();
    if (!$('#createBox').classList.contains('hidden')) buildCreateForm();
    if (L.room && isRoomVisible()) renderRoom();
    if (L.room) { renderChats(); updateDc(); }
    if (L.recon && !$('#reconnectOverlay').classList.contains('hidden')) setRecon(L.recon.key, L.recon.params);
    if (L.inviteInfo && !$('#inviteLanding').classList.contains('hidden')) showInviteInfo(L.inviteInfo);
    else if (L.pendingInvite && !$('#inviteLanding').classList.contains('hidden')) peekInvite();
  };
  root.I18N.onChange(() => L.relocalize());
})(typeof self !== 'undefined' ? self : this);
