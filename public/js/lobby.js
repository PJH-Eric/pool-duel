/* 線上：大廳、房間、邀請、聊天、斷線重連畫面。訊息來自 online.js（Net），對局本身交給 PoolGame。 */
(function (root) {
  'use strict';
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const Net = root.Net, Store = root.Store, Sound = root.Sound, Nick = root.Nicknames;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const firstChar = n => Array.from(String(n || '?'))[0] || '?';
  const KIND_NAME = { nine: '簡化九球', eight: '八號球', score: '14-1 連續進球' };
  const QUICK = ['加油！', '好球！', '好險！', '哈哈', '再一局', '謝謝', '掰掰'];
  const L = {
    room: null, rooms: [], pendingInvite: null, awaitJoin: 0, wasInRoom: false, lastChatAt: 0, dcEnd: 0, dcTimer: 0,
    create: { kind: 'nine', aim: 'full', pockets: 'standard' },
    inGame: false
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
    $('#btnQuick').onclick = () => { commitNick(); Net.send({ type: 'quick' }) || app().toast('還沒連上伺服器'); };
    $('#btnCreateToggle').onclick = () => { $('#createBox').classList.toggle('hidden'); buildCreateForm(); };
    $('#btnCreate').onclick = () => { commitNick(); Net.send(Object.assign({ type: 'create' }, L.create)); $('#createBox').classList.add('hidden'); };
    $('#roomBack').onclick = () => L.leaveRoom();
    $('#btnReady').onclick = () => { const me = myMember(); if (me) Net.send({ type: 'ready', ready: !me.ready }); };
    $('#btnStartRoom').onclick = () => Net.send({ type: 'start' });
    $('#btnTakeSeat').onclick = () => Net.send({ type: 'seat' });
    $$('[data-quick]').forEach(box => { QUICK.forEach(t => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = t; b.onclick = () => Net.send({ type: 'chat', text: t }); box.appendChild(b); }); });
    $$('[data-chatform]').forEach(f => f.addEventListener('submit', e => { e.preventDefault(); const i = f.querySelector('input'); const t = i.value.trim(); if (t) Net.send({ type: 'chat', text: t }); i.value = ''; }));
    const q = new URLSearchParams(location.search).get('invite');
    if (q) { L.pendingInvite = q; L.enter(); }
  };
  function commitNick() {
    let v = $('#nickInput').value.replace(/\s+/g, ' ').trim().slice(0, 8);
    if (!v) v = Store.get('nickname') || Nick.random();
    $('#nickInput').value = v; Store.set('nickname', v);
    Net.name = v; if (Net.status === 'open') Net.send({ type: 'rename', name: v });
  }
  L.enter = function () {
    app().show('lobby'); buildCreateForm(); renderRooms();
    if (!Net.enabled) { setStatus('只有單機版：這份網頁沒有設定伺服器網址，所以不能線上對戰。', 'warn'); return; }
    Net.connect(Store.get('nickname'));
    if (Net.status === 'open') { Net.send({ type: 'rooms' }); setStatus('已連線', 'ok'); if (L.pendingInvite) peekInvite(); }
  };
  L.leaveRoom = function (toHome) {
    Net.send({ type: 'leave' });
    L.room = null; L.wasInRoom = false;
    if (app().game) app().game.stop();
    app().show(toHome ? 'home' : 'lobby');
    $('#resultOverlay').classList.add('hidden');
  };
  function setStatus(text, kind) { const el = $('#lobbyStatus'); el.textContent = text; el.className = 'status-pill' + (kind ? ' ' + kind : ''); el.classList.toggle('hidden', !text); }
  const myMember = () => L.room && L.room.members.find(m => m.id === Net.personId);

  /* ---------- 連線事件 ---------- */
  Net.on('status', s => {
    if (s.status === 'open') { setStatus('已連線', 'ok'); setTimeout(() => { if (Net.status === 'open' && !L.room) setStatus(''); }, 1800); }
    else if (s.text) setStatus(s.text, s.status === 'failed' ? 'warn' : '');
    const ov = $('#reconnectOverlay');
    if (s.status === 'retrying' || s.status === 'waking' || s.status === 'connecting') { if (L.wasInRoom) { ov.classList.remove('hidden'); $('#reconnectText').textContent = s.text || '正在重新連線…'; } }
    if (s.status === 'failed' && L.wasInRoom) { ov.classList.add('hidden'); roomLost('連不上伺服器，已離開房間'); }
  });
  Net.on('welcome', m => {
    $('#nickInput').value = m.name; Store.set('nickname', m.name);
    if (L.pendingInvite) peekInvite();
    if (L.wasInRoom) { clearTimeout(L.awaitJoin); L.awaitJoin = setTimeout(() => { if (L.wasInRoom) roomLost('房間已經不在了（伺服器可能重新啟動）'); }, 1500); }
  });
  function roomLost(text) {
    L.room = null; L.wasInRoom = false; $('#reconnectOverlay').classList.add('hidden'); $('#resultOverlay').classList.add('hidden');
    if (app().game) app().game.stop();
    app().toast(text); app().show('lobby'); setStatus('');
    if (Net.status === 'open') Net.send({ type: 'rooms' });
  }
  Net.on('rooms', m => { L.rooms = m.rooms; renderRooms(); });
  Net.on('error', m => {
    if (m.code === 'invite') showInviteError(m.text);
    else {
      if (m.code === 'extension' && app().game && app().game.cfg && app().game.cfg.mode === 'online') app().game.extensionRejected();
      app().toast(m.text || '發生錯誤');
    }
  });
  Net.on('notice', m => app().toast(m.text));
  Net.on('joined', m => {
    clearTimeout(L.awaitJoin); $('#reconnectOverlay').classList.add('hidden');
    L.room = m.room; L.wasInRoom = true; L.inGame = false;
    if (L.pendingInvite) { L.pendingInvite = null; $('#inviteLanding').classList.add('hidden'); try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } }
    if (m.rejoined && (m.room.phase !== 'lobby')) app().toast('已回到原本的位置');
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
      const seats = [0, 1].map(i => { const mm = m.room.members.find(x => x.role === 'player' && x.seat === i); return { name: mm ? mm.name : '空位' }; });
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
  Net.on('closed', m => { app().toast(m.why || '房間已結束'); roomLost(m.why || '房間已結束'); });
  Net.on('kicked', () => roomLost('你被房主請出房間了'));
  Net.on('left', () => { /* leaveRoom 已處理 */ });
  Net.on('invite', m => { if (L.room) { L.room.invite = m.token; renderInvite(); } });
  Net.on('invite:info', m => showInviteInfo(m));
  Net.on('dropped', () => { if (L.wasInRoom) { $('#reconnectOverlay').classList.remove('hidden'); $('#reconnectText').textContent = '連線中斷，正在重新連線…對局中斷線會保留 30 秒。'; } });

  /* ---------- 邀請 ---------- */
  function peekInvite() { if (L.pendingInvite) { setTimeout(() => Net.send({ type: 'invite:peek', token: L.pendingInvite }), 50); $('#inviteLanding').classList.remove('hidden'); $('#inviteLanding').innerHTML = '<p class="note">正在確認邀請連結…</p>'; } }
  function showInviteInfo(m) {
    const box = $('#inviteLanding'); box.classList.remove('hidden');
    if (!m.ok) { box.innerHTML = '<h3 class="sec tight">邀請連結</h3><p class="res-reason">' + esc(m.text) + '</p><button class="btn small" id="invDismiss">知道了</button>'; $('#invDismiss').onclick = () => { L.pendingInvite = null; box.classList.add('hidden'); try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } }; return; }
    box.innerHTML = '<h3 class="sec tight">朋友邀請你一起玩</h3><p class="res-reason" style="margin:0 0 10px">房間「' + esc(m.roomName) + '」・' + esc(m.kindName) + (m.full ? '<br>目前席位已滿或對局進行中，你會以<b>觀戰者</b>身分進入（空出來可以搶位）。' : '') + '<br>確認下面的暱稱後再加入。</p><button class="btn gold" id="invJoin">' + (m.full ? '加入觀戰' : '加入房間') + '</button>';
    $('#invJoin').onclick = () => { commitNick(); Net.send({ type: 'invite:resolve', token: L.pendingInvite, name: Store.get('nickname') }); };
  }
  function showInviteError(text) { const box = $('#inviteLanding'); box.classList.remove('hidden'); box.innerHTML = '<h3 class="sec tight">邀請連結</h3><p class="res-reason">' + esc(text) + '</p>'; L.pendingInvite = null; }

  /* ---------- 大廳 ---------- */
  function seg(el, opts, cur, onPick) {
    el.innerHTML = '';
    opts.forEach(o => { const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-b'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(o[0]) === String(cur) ? 'true' : 'false'); b.textContent = o[1]; b.onclick = () => onPick(o[0]); el.appendChild(b); });
  }
  const OPT = {
    kind: [['nine', '九球'], ['eight', '八號球'], ['score', '14-1']],
    aim: [['full', '完整'], ['short', '簡短'], ['off', '關閉']],
    pockets: [['standard', '標準'], ['big', '加大']]
  };
  const LABEL = { kind: '玩法', aim: '瞄準輔助', pockets: '袋口' };
  function buildCreateForm() {
    const f = $('#createForm'); f.innerHTML = '';
    Object.keys(OPT).forEach(k => {
      const lb = document.createElement('span'); lb.className = 'lbl'; lb.textContent = LABEL[k]; const sg = document.createElement('div'); sg.className = 'seg'; sg.setAttribute('role', 'radiogroup'); sg.setAttribute('aria-label', LABEL[k]);
      seg(sg, OPT[k], L.create[k], v => { L.create[k] = v; buildCreateForm(); });
      f.appendChild(lb); f.appendChild(sg);
    });
    addFixedTurnRow(f);
  }
  function renderRooms() {
    const box = $('#roomList');
    if (!L.rooms.length) { box.innerHTML = '<div class="empty">目前沒有公開房間。<br>按「快速加入」會幫你開一間等朋友，或自己「建立房間」後用邀請連結叫朋友。</div>'; return; }
    box.innerHTML = '';
    L.rooms.forEach(r => {
      const row = document.createElement('div'); row.className = 'room-row';
      const canPlay = r.players < r.seats && r.phase === 'lobby';
      row.innerHTML = '<div class="grow"><div class="rn">' + esc(r.name) + '</div><div class="rm">' + esc(r.kindName) + ' ・ ' + r.players + '/' + r.seats + ' 人' + (r.spectators ? ' ・ ' + r.spectators + ' 人觀戰' : '') + ' ・ ' + (r.phase === 'lobby' ? '等待中' : '對局中') + '</div></div>';
      const b = document.createElement('button'); b.className = 'btn small' + (canPlay ? ' gold' : ''); b.textContent = canPlay ? '加入' : '觀戰';
      b.onclick = () => { commitNick(); Net.send({ type: 'join', roomId: r.id, role: canPlay ? 'player' : 'spectator' }); };
      row.appendChild(b); box.appendChild(row);
    });
  }

  /* ---------- 房間 ---------- */
  function renderRoom() {
    const r = L.room; if (!r || app().screen !== 'room') return;
    $('#roomTitle').textContent = r.name;
    const players = [0, 1].map(i => r.members.find(m => m.role === 'player' && m.seat === i));
    $('#seatCards').innerHTML = players.map((m, i) => {
      if (!m) return '<div class="seat-card empty-seat"><div class="avatar sp">？</div><div class="nm">空位</div><div class="st">等朋友加入</div></div>';
      const mine = m.id === Net.personId;
      return '<div class="seat-card' + (mine ? ' mine' : '') + '"><div class="avatar s' + i + '">' + esc(firstChar(m.name)) + '</div><div class="nm">' + esc(m.name) + (mine ? '（你）' : '') + (m.host ? ' ★' : '') + '</div><div class="st ' + (m.ready ? 'ready' : '') + '">' + (m.connected ? (m.ready ? '已準備' : '尚未準備') : '離線') + '</div></div>';
    }).join('');
    const specs = r.members.filter(m => m.role === 'spectator');
    $('#specCount').textContent = specs.length + '/' + r.maxSpectators;
    $('#specList').innerHTML = specs.length ? specs.map(m => '<span class="spec"><i class="dc-dot' + (m.connected ? '' : ' off') + '"></i>' + esc(m.name) + (m.id === Net.personId ? '（你）' : '') + (r.isHost && m.id !== Net.personId ? ' <button class="btn small" data-kick="' + m.id + '" style="min-height:24px;padding:0 8px;font-size:12px">請出</button>' : '') + '</span>').join('') : '<span class="note">還沒有人觀戰</span>';
    $$('[data-kick]').forEach(b => b.onclick = () => Net.send({ type: 'kick', targetId: b.dataset.kick }));
    // 設定
    const cfg = $('#roomCfg'); cfg.innerHTML = '<h3 class="sec tight">對局設定' + (r.isHost ? '' : '（房主可調整）') + '</h3>';
    Object.keys(OPT).forEach(k => {
      const row = document.createElement('div'); row.className = 'cfg-row'; row.innerHTML = '<span class="lbl">' + LABEL[k] + '</span>';
      if (r.isHost) { const sg = document.createElement('div'); sg.className = 'seg'; sg.setAttribute('role', 'radiogroup'); sg.setAttribute('aria-label', LABEL[k]); seg(sg, OPT[k], r.cfg[k], v => Net.send({ type: 'config', [k]: v })); row.appendChild(sg); }
      else { const v = (OPT[k].find(o => String(o[0]) === String(r.cfg[k])) || [0, ''])[1]; const sp = document.createElement('span'); sp.className = 'cfg-val'; sp.textContent = v; row.appendChild(sp); }
      cfg.appendChild(row);
    });
    addFixedTurnRow(cfg);
    renderInvite();
    const me = myMember();
    $('#btnTakeSeat').classList.toggle('hidden', !r.canTakeSeat);
    $('#btnReady').classList.toggle('hidden', !(me && me.role === 'player'));
    if (me) { $('#btnReady').textContent = me.ready ? '取消準備' : '準備好'; $('#btnReady').classList.toggle('green', !me.ready); }
    $('#btnStartRoom').classList.toggle('hidden', !r.isHost); $('#btnStartRoom').disabled = !r.canStart;
    let hint = '';
    if (me && me.role === 'spectator') hint = '你現在是觀戰者。座位空出來時可以「搶位入座」。';
    else if (players.filter(Boolean).length < 2) hint = '等朋友加入：把下面的邀請連結貼給他，或等其他人從大廳進來。';
    else if (!r.isHost) hint = me && me.ready ? '已準備，等房主開始。' : '準備好就按「準備好」。';
    else hint = r.canStart ? '兩個人都準備好了，可以開始！' : '等兩個人都按「準備好」，房主才能開始。';
    $('#roomHint').textContent = hint;
    $('#roomDc').classList.toggle('hidden', !r.dc);
  }
  function addFixedTurnRow(container) {
    const row = document.createElement('div'); row.className = 'fixed-turn-row';
    const label = document.createElement('span'); label.className = 'lbl'; label.textContent = '回合時間';
    const value = document.createElement('div'); value.className = 'cfg-val';
    const time = document.createElement('span'); time.className = 'fixed-turn-time'; time.textContent = '35 秒';
    const detail = document.createElement('span'); detail.className = 'fixed-turn-detail'; detail.textContent = '每位玩家每盤可延長一次';
    const extension = document.createElement('span'); extension.className = 'fixed-turn-extension'; extension.textContent = '+25 秒';
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
    if (!r.invite) { box.innerHTML = '<h3 class="sec tight">邀請連結</h3><p class="note" style="margin-bottom:10px">產生一條只屬於這個房間的連結，貼給朋友就能進來。房間結束時連結自動失效。</p><button class="btn small gold" id="btnMkInvite">產生邀請連結</button>'; $('#btnMkInvite').onclick = () => Net.send({ type: 'invite' }); return; }
    const url = inviteUrl(r.invite);
    box.innerHTML = '<h3 class="sec tight">邀請連結</h3><div class="invite-row"><input class="field selectable" readonly value="' + esc(url) + '" aria-label="邀請連結"><button class="btn small gold" id="btnCopyInvite">複製</button></div><div class="row" style="margin-top:10px"><button class="btn small ghost" id="btnReInvite">換一條新的</button><button class="btn small ghost" id="btnRevoke">撤銷連結</button></div>';
    $('#btnCopyInvite').onclick = () => copy(url);
    $('#btnReInvite').onclick = () => Net.send({ type: 'invite' });
    $('#btnRevoke').onclick = () => Net.send({ type: 'invite:revoke' });
  }
  function copy(text) {
    const done = () => app().toast('已複製邀請連結');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    function fallback() { const i = $('#inviteBox input'); if (i) { i.select(); try { document.execCommand('copy'); done(); } catch (e) { app().toast('請長按連結手動複製'); } } }
  }

  /* ---------- 聊天 ---------- */
  function renderChats() {
    const r = L.room; if (!r) return;
    const html = r.chat.map(c => c.sys ? '<div class="msg sys">' + esc(c.text) + '</div>' :
      '<div class="msg' + (c.id === Net.personId ? ' me' : '') + '"><span class="who">' + esc(c.who) + (c.role === 'spectator' ? '（觀戰）' : '') + '</span>' + esc(c.text) + '</div>').join('');
    ['#roomChat', '#gChat'].forEach(sel => { const el = $(sel); const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40; el.innerHTML = html; if (atBottom || true) el.scrollTop = el.scrollHeight; });
  }

  /* ---------- 斷線倒數 ---------- */
  function updateDc() {
    const r = L.room, banner = $('#dcBanner'), roomDc = $('#roomDc');
    clearInterval(L.dcTimer);
    if (!r || !r.dc || r.phase !== 'playing') { banner.classList.add('hidden'); return; }
    const who = r.members.find(m => m.id === r.dc.id); const name = who ? who.name : '對手';
    L.dcEnd = performance.now() + r.dc.ms;
    const paint = () => {
      const sec = Math.max(0, Math.ceil((L.dcEnd - performance.now()) / 1000));
      const mine = myMember() && myMember().role === 'player';
      banner.textContent = mine ? name + ' 斷線了，' + sec + ' 秒內沒回來就判你獲勝' : name + ' 斷線了，' + sec + ' 秒內沒回來就判負';
    };
    banner.classList.remove('hidden'); paint(); L.dcTimer = setInterval(paint, 500);
  }
})(typeof self !== 'undefined' ? self : this);
