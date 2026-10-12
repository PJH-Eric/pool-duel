/* 介面總管：首頁（會自己打球的桌面）、單機設定、設定視窗、說明、對局介面。 */
(function (root) {
  'use strict';
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const Store = root.Store, Sound = root.Sound, Rules = root.PoolRules, AI = root.PoolAI, P = root.PoolPhysics, C = root.PoolConfig, Themes = root.PoolThemes, RNG = root.RNG;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const firstChar = n => Array.from(String(n || '?'))[0] || '?';
  const App = { screen: 'home', game: null, back: 'home', setupNote: '' };
  root.PoolApp = App;

  /* ---------- 小工具 ---------- */
  let gtT = 0;
  App.toast = function (text, ms) {
    if (App.screen === 'game' && App.game && App.game.ui && App.game.ui.toast) { App.game.ui.toast(text); return; }   // 對局中提示一律顯示在桌面上方
    const el = $('#globalToast'); el.textContent = text; el.classList.add('show');
    clearTimeout(gtT); gtT = setTimeout(() => el.classList.remove('show'), ms || 2600);
  };
  App.show = function (name) {
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    App.screen = name;
    if (name === 'home') Hero.start(); else Hero.stop();
    if (name !== 'game' && App.game) App.game.stop();
    if (name === 'setup') refreshSetup();
    Latency.refresh();
    const sc = $('#screen-' + name + ' .scroll'); if (sc) sc.scrollTop = 0;
  };
  function confirmBox(title, text, yesLabel) {
    return new Promise(res => {
      const m = $('#confirmModal'); $('#cfTitle').textContent = title; $('#cfText').textContent = text; $('#cfYes').textContent = yesLabel || '確定';
      m.classList.remove('hidden'); const prev = document.activeElement; $('#cfNo').focus();
      const done = v => { m.classList.add('hidden'); $('#cfYes').onclick = $('#cfNo').onclick = null; m.onkeydown = null; if (prev && prev.focus) prev.focus(); res(v); };
      $('#cfYes').onclick = () => done(true); $('#cfNo').onclick = () => done(false);
      m.onkeydown = e => { if (e.key === 'Escape') done(false); trapTab(e, m); };
    });
  }
  App.confirm = confirmBox;
  function trapTab(e, box) {
    if (e.key !== 'Tab') return;
    const f = Array.from(box.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')).filter(x => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const a = f[0], b = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { b.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === b) { a.focus(); e.preventDefault(); }
  }

  /* ---------- 首頁：自己打球的桌面 ---------- */
  const Hero = {
    r: null, raf: 0, on: false, state: null, world: null, rng: null, idleUntil: 0, last: 0, drop: [],
    init() {
      const cv = $('#heroCanvas'); this.cv = cv; this.r = root.PoolRender.create(cv);
      this.rng = RNG.create(RNG.newSeed());
      this.newGame();
      root.addEventListener('resize', () => { if (this.on) this.r.resize(); });
    },
    newGame() { this.state = Rules.newGame('nine', { breaker: 0 }, this.rng); this.world = null; this.idleUntil = performance.now() + 800; this.r.resetRolls && this.r.resetRolls(); },
    start() {
      if (!this.r) this.init();
      if (this.on) return;
      this.on = true; this.r.setTheme({ felt: Store.get('felt'), scene: Store.get('scene') }); this.r.resize();
      this.last = performance.now();
      this.raf = requestAnimationFrame(t => this.frame(t));
    },
    stop() { this.on = false; cancelAnimationFrame(this.raf); },
    frame(now) {
      if (!this.on) return;
      const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
      const still = Store.get('reduceMotion');
      if (!still) this.step(dt, now);
      let balls = this.world ? this.world.balls : this.state.balls;
      this.r.draw({ balls, dropping: this.drop.map(d => ({ id: d.id, x: d.x, y: d.y, pocket: d.pocket, t: (now - d.t0) / 320 })) }, now);
      this.drop = this.drop.filter(d => now - d.t0 < 320);
      this.raf = requestAnimationFrame(t => this.frame(t));
    },
    step(dt, now) {
      if (this.world) {
        this.acc = (this.acc || 0) + dt * 0.8;
        let n = 0; while (this.acc >= C.DT && n < 60) { P.stepWorld(this.world); this.acc -= C.DT; n++; if (P.isAtRest(this.world)) break; }
        for (const e of this.world.events) if (e.type === 'pocket') this.drop.push({ id: e.ball, x: e.x, y: e.y, pocket: e.pocket, t0: now });
        this.world.events.length = 0;
        if (P.isAtRest(this.world)) {
          const res = P.collect(this.world), info = Rules.evaluateShot(this.state, this.curShot, res);
          this.state = info.state; this.world = null; this.idleUntil = now + 900;
          if (this.state.phase === 'over') { this.newGame(); this.idleUntil = now + 1500; }
        }
      } else if (now >= this.idleUntil) {
        const s = this.state;
        if (s.phase === 'choice') { const r = Rules.resolveChoice(s, Rules.defaultChoice(s), this.rng); this.state = r.state; return; }
        const pick = AI.chooseShot(s, 'normal', this.rng);
        this.curShot = pick.shot;
        this.world = Rules.prepareWorld(s, pick.shot); this.world.recordEvents = true; P.applyShot(this.world, pick.shot); this.world.events.length = 0;
      }
    }
  };

  /* ---------- 設定 ---------- */
  const SETTINGS_DEF = [
    { g: '聲音' },
    { k: 'musicOn', t: 'toggle', b: '背景音樂', d: '輕爵士酒吧風' },
    { k: 'musicVol', t: 'slider', b: '音樂音量' },
    { k: 'sfxOn', t: 'toggle', b: '音效', d: '擊球、碰庫、進袋' },
    { k: 'sfxVol', t: 'slider', b: '音效音量' },
    { k: 'vibrate', t: 'toggle', b: '震動', d: '手機進袋與犯規時震動' },
    { g: '操作' },
    { k: 'aim', t: 'seg', b: '瞄準輔助', d: '單機用；線上由房主統一決定', opts: [['full', '完整'], ['short', '簡短'], ['off', '關閉']] },
    { k: 'showSpin', t: 'toggle', b: '擊球點面板預設展開', d: '平常收起，要用時再點「擊球點」' },
    { k: 'swapControls', t: 'toggle', b: '操作列左右對調', d: '左手習慣者使用' },
    { g: '畫面' },
    { k: 'bigNumbers', t: 'toggle', b: '放大球號', d: '球上的數字加大' },
    { k: 'colorAssist', t: 'toggle', b: '色彩輔助', d: '加強球的對比與邊框' },
    { k: 'reduceMotion', t: 'toggle', b: '減少動態', d: '關閉首頁動畫與轉場' },
    { g: '桌布（只影響你自己的畫面）' },
    { k: 'felt', t: 'swatch', opts: Object.keys(Themes.FELTS).map(k => [k, Themes.FELTS[k].name, 'background:radial-gradient(circle at 40% 35%,' + Themes.FELTS[k].c1 + ',' + Themes.FELTS[k].c3 + ')']) },
    { g: '場景（只影響你自己的畫面）' },
    { k: 'scene', t: 'swatch', opts: Object.keys(Themes.SCENES).map(k => [k, Themes.SCENES[k].name, 'background:linear-gradient(' + Themes.SCENES[k].top + ',' + Themes.SCENES[k].bottom + ')']) },
    { g: '球桿（對手與觀戰者看得到）' },
    { k: 'cue', t: 'swatch', cue: true, opts: Object.keys(Themes.CUES).map(k => [k, Themes.CUES[k].name, '', Themes.CUES[k]]) }
  ];
  let settingsOpener = null;
  function buildSettings() {
    const body = $('#setBody'); body.innerHTML = '';
    SETTINGS_DEF.forEach(def => {
      if (def.g) { const g = document.createElement('div'); g.className = 'set-group'; g.textContent = def.g; body.appendChild(g); return; }
      const row = document.createElement('div'); row.className = 'set-row'; row.dataset.k = def.k;
      if (def.t === 'swatch') {
        const box = document.createElement('div'); box.className = 'swatches'; box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', def.k);
        def.opts.forEach(o => {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch'; b.setAttribute('role', 'radio'); b.dataset.v = o[0];
          const style = def.cue ? '--tip:' + o[3].tip + ';--shaft:' + o[3].shaft + ';--butt:' + o[3].butt + ';background:#2a1a10' : o[2];
          b.innerHTML = '<span class="sw' + (def.cue ? ' cue' : '') + '" style="' + style + '"></span>' + esc(o[1]);
          b.onclick = () => { Store.set(def.k, o[0]); Sound.sfx.click(); syncSettings(); };
          box.appendChild(b);
        });
        row.style.display = 'block'; row.appendChild(box);
      } else {
        const tx = document.createElement('div'); tx.className = 'tx'; tx.innerHTML = '<b>' + esc(def.b) + '</b>' + (def.d ? '<span>' + esc(def.d) + '</span>' : '');
        row.appendChild(tx);
        if (def.t === 'toggle') {
          const t = document.createElement('button'); t.type = 'button'; t.className = 'toggle'; t.setAttribute('role', 'switch'); t.setAttribute('aria-label', def.b);
          t.onclick = () => { Store.set(def.k, !Store.get(def.k)); Sound.unlock(); Sound.sfx.click(); syncSettings(); };
          row.appendChild(t);
        } else if (def.t === 'slider') {
          const s = document.createElement('div'); s.className = 'slider set-slider'; s.setAttribute('role', 'slider'); s.setAttribute('aria-label', def.b); s.tabIndex = 0;
          s.innerHTML = '<div class="knob"></div>'; row.appendChild(s);
          bindSlider(s, { min: 0, max: 1, step: 0.05, get: () => Store.get(def.k), set: v => { Store.set(def.k, v); Sound.unlock(); }, end: () => Sound.sfx.click() });
        } else if (def.t === 'seg') {
          const sg = document.createElement('div'); sg.className = 'seg'; sg.setAttribute('role', 'radiogroup'); sg.setAttribute('aria-label', def.b);
          def.opts.forEach(o => { const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-b'; b.setAttribute('role', 'radio'); b.dataset.v = o[0]; b.textContent = o[1]; b.onclick = () => { Store.set(def.k, o[0]); Sound.sfx.click(); syncSettings(); }; sg.appendChild(b); });
          row.appendChild(sg);
        }
      }
      body.appendChild(row);
    });
    syncSettings();
  }
  function syncSettings() {
    $$('#setBody .set-row').forEach(row => {
      const k = row.dataset.k, v = Store.get(k);
      const t = row.querySelector('.toggle'); if (t) t.setAttribute('aria-checked', v ? 'true' : 'false');
      row.querySelectorAll('.seg-b, .swatch').forEach(b => b.setAttribute('aria-checked', b.dataset.v === v ? 'true' : 'false'));
      const s = row.querySelector('.set-slider'); if (s) s.__render && s.__render();
    });
  }
  function applySettings() {
    Sound.setVolumes({ musicOn: Store.get('musicOn'), musicVol: Store.get('musicVol'), sfxOn: Store.get('sfxOn'), sfxVol: Store.get('sfxVol') });
    document.body.classList.toggle('reduce-motion', !!Store.get('reduceMotion'));
    document.body.classList.toggle('high-contrast', !!Store.get('colorAssist'));
    $('#gControls').classList.toggle('swap', !!Store.get('swapControls'));
    const th = { felt: Store.get('felt'), scene: Store.get('scene'), cue: Store.get('cue'), bigNumbers: Store.get('bigNumbers'), colorAssist: Store.get('colorAssist') };
    if (App.game) App.game.r.setTheme(th);
    if (Hero.r) Hero.r.setTheme(th);
    const open = !$('#spinPop').classList.contains('hidden');
    if (Store.get('showSpin') && !open && App.screen === 'game') setSpinOpen(true);
  }
  Store.onChange((k) => {
    applySettings();
    if (k === 'cue' && root.Net && Net.status === 'open') Net.send({ type: 'cue', cue: Store.get('cue') });
  });
  App.openSettings = function () {
    settingsOpener = document.activeElement;
    buildSettings(); const m = $('#settingsModal'); m.classList.remove('hidden'); $('#setClose').focus();
  };
  function closeSettings() { $('#settingsModal').classList.add('hidden'); if (settingsOpener && settingsOpener.focus) settingsOpener.focus(); }
  $('#setClose').onclick = $('#setDone').onclick = closeSettings;
  $('#settingsModal').addEventListener('pointerdown', e => { if (e.target.id === 'settingsModal') closeSettings(); });
  $('#settingsModal').addEventListener('keydown', e => { if (e.key === 'Escape') { closeSettings(); e.stopPropagation(); } trapTab(e, $('#settingsModal')); });
  $('#setReset').onclick = () => { Store.reset(); buildSettings(); applySettings(); App.toast('已恢復預設'); };
  document.addEventListener('click', e => { const g = e.target.closest('[data-gear], #homeGear'); if (g) App.openSettings(); });

  /* ---------- 通用滑桿 ---------- */
  function bindSlider(el, o) {
    const knob = el.querySelector('.knob'), fill = el.querySelector('.fill');
    const frac = () => (o.get() - o.min) / (o.max - o.min);
    const render = () => {
      const f = Math.max(0, Math.min(1, frac()));
      knob.style.left = 'calc(17px + (100% - 34px) * ' + f + ')';
      if (fill) fill.style.width = 'calc(4px + (100% - 8px) * ' + f + ')';
      el.setAttribute('aria-valuenow', String(Math.round(o.get() * (o.aria || 1) * 100) / 100));
    };
    el.__render = render;
    const fromPointer = e => {
      const r = el.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left - 17) / (r.width - 34)));
      let v = o.min + f * (o.max - o.min); v = Math.round(v / o.step) * o.step;
      if (o.snap != null && Math.abs(v - o.snap) <= o.snapR) v = o.snap;
      o.set(Math.max(o.min, Math.min(o.max, +v.toFixed(4)))); render();
    };
    let drag = false;
    el.addEventListener('pointerdown', e => { drag = true; el.setPointerCapture(e.pointerId); fromPointer(e); e.preventDefault(); });
    el.addEventListener('pointermove', e => { if (drag) fromPointer(e); });
    const end = () => { if (drag) { drag = false; o.end && o.end(); } };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', e => {
      const st = o.step * (e.shiftKey ? 5 : 1); let v = o.get();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v -= st; else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v += st; else return;
      o.set(Math.max(o.min, Math.min(o.max, +v.toFixed(4)))); render(); e.preventDefault();
    });
    render();
    return render;
  }

  /* ---------- 單機設定 ---------- */
  const KIND_INFO = [
    { id: 'nine', name: '簡化九球', tag: '預設', ball: '#f0be1e', stripe: true, desc: '一局約 5 分鐘。先碰桌上最小號的球，把 9 號球打進袋就贏。' },
    { id: 'eight', name: '八號球', tag: '正式規則', ball: '#17171a', desc: '分全色球與半色球，先清完自己的球，再把 8 號球打進指定的袋口。' },
    { id: 'score', name: '14-1 球', tag: '叫球', ball: '#d8322a', desc: '先點球、再點袋口叫球；叫中得 1 分並繼續，犯規扣 1 分，先拿 30 分獲勝。' }
  ];
  const LEVEL_INFO = [
    { id: 'kids', name: '幼幼班', note: '袋口放大 25%、不判犯規、電腦常常失手，還有完整的輔助線。適合小朋友第一次玩。' },
    { id: 'easy', name: '簡單', note: '電腦打最近的球，有時會失誤，也不太會想接下來的走位。' },
    { id: 'normal', name: '普通', note: '電腦會挑好打的球與袋口，會避免犯規，沒球可打時會打防守。' },
    { id: 'hard', name: '困難', note: '電腦會用同一套物理引擎預演多種打法、考慮走位與旋轉，很少失誤。' },
    { id: 'myth', name: '神話', note: '幾乎不會失手：預演更多球路與力道、用定桿拉桿推桿精算走位，沒把握時會打安全球。真的很難贏。' }
  ];
  let setupKind = 'nine', setupMode = 'ai', setupLevel = 'easy';
  function refreshSetup() {
    const box = $('#kindCards'); box.innerHTML = '';
    KIND_INFO.forEach(k => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'kcard'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', k.id === setupKind ? 'true' : 'false');
      const ballStyle = k.stripe ? 'background:linear-gradient(' + k.ball + ' 0 28%,#f6f1e4 28% 72%,' + k.ball + ' 72%)' : 'background:' + k.ball;
      b.innerHTML = '<div class="k-top"><span class="kball" style="' + ballStyle + '"></span><span class="k-name">' + k.name + '</span><span class="k-tag">' + k.tag + '</span></div><p>' + k.desc + '</p>';
      b.onclick = () => { setupKind = k.id; Sound.sfx.click(); refreshSetup(); };
      box.appendChild(b);
    });
    $$('#modeSeg .seg-b').forEach(b => { b.setAttribute('aria-checked', b.dataset.v === setupMode ? 'true' : 'false'); b.onclick = () => { setupMode = b.dataset.v; Sound.sfx.click(); refreshSetup(); }; });
    const ls = $('#levelSeg'); ls.innerHTML = '';
    LEVEL_INFO.forEach(l => { const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-b'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', l.id === setupLevel ? 'true' : 'false'); b.textContent = l.name; b.onclick = () => { setupLevel = l.id; Sound.sfx.click(); refreshSetup(); }; ls.appendChild(b); });
    $('#levelNote').textContent = (LEVEL_INFO.find(l => l.id === setupLevel) || {}).note || '';
    $('#levelBox').classList.toggle('hidden', setupMode !== 'ai');
    $('#practiceNote').classList.toggle('hidden', setupMode !== 'practice');
    $('#btnStartSolo').textContent = setupMode === 'ai' ? '開始對戰' : '開始練習';
  }
  $('#btnStartSolo').onclick = () => {
    Store.set('lastKind', setupKind); Store.set('lastLevel', setupLevel); Store.set('lastMode', setupMode);
    Sound.unlock();
    App.startSolo({ mode: setupMode, kind: setupKind, level: setupLevel });
  };

  /* ---------- 對局介面 ---------- */
  let unread = 0;
  function ensureGame() {
    if (App.game) return App.game;
    App.game = new root.PoolGame($('#gCanvas'), App.ui, Store);
    return App.game;
  }
  App.startSolo = function (cfg) {
    App.back = 'setup';
    App.show('game');
    const g = ensureGame(); g.resume();
    const you = Store.get('nickname') || '你';
    const lv = LEVEL_INFO.find(l => l.id === cfg.level);
    const seats = cfg.mode === 'practice' ? [{ name: you }, { name: '練習' }] : [{ name: you }, { name: '電腦（' + (lv ? lv.name : '') + '）' }];
    $('#gChatBox').classList.add('hidden'); $('#gSpec').classList.add('hidden');
    $('#btnRack').classList.toggle('hidden', cfg.mode !== 'practice');
    g.practiceCount = 0;
    g.start({ mode: cfg.mode, kind: cfg.kind, level: cfg.mode === 'practice' ? 'kids' : cfg.level, mySeat: 0, seats, bigPockets: cfg.level === 'kids' });
    applySettings();
    resetDrawer();
  };
  App.startOnlineGame = function (gameMsg, room, extra) {
    App.show('game');
    const g = ensureGame(); g.resume();
    $('#btnRack').classList.add('hidden');
    $('#gChatBox').classList.remove('hidden');
    const me = room.youSeat;
    g.start({ mode: 'online', kind: gameMsg.kind, mySeat: me, state: gameMsg.state, seats: gameMsg.seats.map(s => ({ name: s.name })), cues: gameMsg.seats.map(s => s.cue), aimMode: gameMsg.cfg.aim, net: root.Net, turnMs: gameMsg.turnMs, bigPockets: gameMsg.cfg.pockets === 'big' });
    $('#gSpec').classList.toggle('hidden', me >= 0);
    $('#gSpec').textContent = '你是觀戰者：可以看全桌、可以聊天';
    applySettings(); resetDrawer(); unread = 0; updateUnread();
  };

  const seatHtml = (s, mini) => {
    return '<div class="avatar s' + s.seat + (mini ? ' sm' : '') + '" aria-hidden="true">' + esc(firstChar(s.name)) + '</div>';
  };
  function miniBall(id, out, next) {
    const col = Themes.ballColor(id);
    const style = id >= 9 ? 'background:linear-gradient(' + col + ' 0 28%,#f6f1e4 28% 72%,' + col + ' 72%)' : 'background:' + col;
    return '<span class="mini-ball' + (out ? ' out' : '') + (next ? ' next' : '') + '" style="' + style + '" title="' + id + ' 號"><b>' + id + '</b></span>';
  }
  App.ui = {
    hud(vm) {
      $('#gKind').textContent = vm.kindName;
      const st = $('#gStatus'); st.textContent = vm.status; st.classList.toggle('mine', vm.status.indexOf('輪到你') === 0 || vm.status === '請做出選擇');
      $('#gHint').innerHTML = '<b>' + esc(vm.hint).replace(/^規則：/, '規則：') + '</b>';
      $('#gHint').innerHTML = esc(vm.hint);
      let html = '', cap = '';
      vm.seats.forEach(s => {
        const tag = s.you ? '<span class="tag">你</span>' : '';
        const right = vm.kind === 'score' ? '<span class="pscore">' + s.score + '</span>' : '';
        html += '<div class="pseat' + (s.isTurn ? ' turn' : '') + '">' + seatHtml(s) + '<div><div class="pname"><span class="n">' + esc(s.name) + '</span>' + tag + right + '</div><div class="pline">' + esc(s.line1) + (s.line2 && vm.kind !== 'score' ? ' ・ ' + esc(s.line2) : '') + '</div></div>' +
          '<div class="pballs">' + (s.balls || []).map(b => miniBall(b.id, b.out, b.next)).join('') + '</div></div>';
        cap += '<div class="capsule' + (s.isTurn ? ' turn' : '') + '">' + seatHtml(s, true) + '<div style="min-width:0"><div class="cn">' + esc(s.name) + (s.you ? '（你）' : '') + '</div><div class="cl">' + (vm.kind === 'score' ? s.score + ' 分' : esc(s.line1)) + '</div></div></div>';
      });
      $('#gSeats').innerHTML = html; $('#gCapsules').innerHTML = cap;
      if (vm.practice) $('#gHint').innerHTML = esc(vm.hint) + '<br><b>已進袋：' + (vm.potted || 0) + ' 顆</b>';
    },
    controls(c) {
      const dis = !c.enabled;
      $('#btnShoot').disabled = !c.canShoot;
      $('#btnSafety').classList.toggle('hidden', !c.safetyBtn); $('#btnSafety').setAttribute('aria-pressed', c.safety ? 'true' : 'false');
      $('#fineSlider').classList.toggle('off', dis); $('#powerSlider').classList.toggle('off', dis);
      $('#spinBtn').disabled = dis; $$('#cueModes button').forEach(b => { b.disabled = dis; }); $('#gControls').classList.toggle('spectate', !!c.spectator);
      $('#btnShoot').textContent = c.spectator ? '觀戰中' : (c.needCall && !c.canShoot ? '先叫球' : (c.thinking ? '對手思考中' : '擊 球'));
    },
    power(p) { $('#powerVal').textContent = Math.round(p * 100) + '%'; powerSlider.render(); },
    fine(d) { $('#fineVal').textContent = (d >= 0 ? '+' : '') + d.toFixed(2) + '°'; fineSlider.render(); },
    spin(u, v) { setSpinDot(u, v); },
    toast(text, kind) {
      const el = $('#toast'); el.textContent = text; el.className = 'toast show' + (kind === 'foul' ? ' foul' : '');
      clearTimeout(el.__t); el.__t = setTimeout(() => el.classList.remove('show'), 2800);
    },
    timer(sec, mine) {
      const el = $('#gTimer'), wrap = $('#gTimerWrap');
      if (sec == null) { el.textContent = '--'; el.classList.remove('low'); return; }
      el.textContent = sec; el.classList.toggle('low', !!mine && sec <= 5);
    },
    result(vm) { showResult(vm); },
    choice(vm) { showChoice(vm); }
  };

  /* 擊球點 */
  let spin = { u: 0, v: 0 };
  function setSpinDot(u, v) {
    spin = { u, v }; syncCueModes();
    const l = (50 + u * 42) + '%', t = (50 + v * 42) + '%';
    [$('#spinDot'), $('#spinMini i')].forEach(d => { d.style.left = l; d.style.top = t; });
  }
  const MODE_NOTE = { follow: '推桿：碰到球後，母球會繼續往前追', stop: '定桿：正撞時，母球會停在原地', draw: '拉桿：碰到球後，母球會往回縮', jump: '跳桿：母球會飛過黃色圈前面的球再落地（力度越大飛越遠）' };
  const MODE_NAME = { follow: '推桿', stop: '定桿', draw: '拉桿', jump: '跳桿' };
  const smallScreen = () => matchMedia('(max-aspect-ratio: 1/1), (max-width: 820px), (max-height: 520px)').matches;
  function placeModes() {            // 小螢幕：四顆出桿按鈕收進擊球點面板；大螢幕：放在擊球點旁
    const box = $('#cueModes'), pop = $('#spinPop'), ctl = document.querySelector('.spin-ctl');
    if (smallScreen()) { if (box.parentNode !== pop) pop.insertBefore(box, pop.querySelector('.spin-tip')); }
    else if (box.parentNode !== ctl) ctl.appendChild(box);
  }
  window.addEventListener('resize', placeModes); placeModes();
  function syncCueModes() { const m = App.game && App.game.cueMode ? App.game.cueMode() : null; $$('#cueModes button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === m ? 'true' : 'false')); const lb = document.querySelector('#spinBtn .lbl'); if (lb) lb.textContent = m ? MODE_NAME[m] : '擊球點'; }
  $$('#cueModes button').forEach(b => { b.onclick = () => { const g = App.game; if (!g) return; g.setCueMode(b.dataset.mode); const m = g.cueMode(); if (m && g.ui.toast) g.ui.toast(MODE_NOTE[m]); }; });
  function setSpinOpen(open) { $('#spinPop').classList.toggle('hidden', !open); $('#spinBtn').setAttribute('aria-expanded', open ? 'true' : 'false'); }
  $('#spinBtn').onclick = () => setSpinOpen($('#spinPop').classList.contains('hidden'));
  $('#spinReset').onclick = () => { App.game && App.game.setSpin(0, 0); };
  (function () {
    const ball = $('#spinBall'); let drag = false;
    const at = e => {
      const r = ball.getBoundingClientRect(), u = ((e.clientX - r.left) / r.width - 0.5) * 2 / 0.84, v = ((e.clientY - r.top) / r.height - 0.5) * 2 / 0.84;
      if (App.game) App.game.setSpin(u, v);
    };
    ball.addEventListener('pointerdown', e => { drag = true; ball.setPointerCapture(e.pointerId); at(e); e.preventDefault(); });
    ball.addEventListener('pointermove', e => { if (drag) at(e); });
    ball.addEventListener('pointerup', () => { drag = false; });
    ball.addEventListener('keydown', e => { const g = App.game; if (!g) return; const st = 0.1; let { u, v } = spin; if (e.key === 'ArrowLeft') u -= st; else if (e.key === 'ArrowRight') u += st; else if (e.key === 'ArrowUp') v -= st; else if (e.key === 'ArrowDown') v += st; else return; g.setSpin(u, v); e.preventDefault(); });
  })();
  document.addEventListener('pointerdown', e => { const pop = $('#spinPop'); if (!pop.classList.contains('hidden') && !Store.get('showSpin') && !e.target.closest('.spin-ctl')) setSpinOpen(false); });

  const powerSlider = { render() {} }, fineSlider = { render() {} };
  powerSlider.render = bindSlider($('#powerSlider'), { min: 0, max: 1, step: 0.01, get: () => (App.game ? App.game.power : 0.5), set: v => App.game && App.game.setPower(Math.max(0.02, v)), aria: 100 });
  fineSlider.render = bindSlider($('#fineSlider'), { min: -4, max: 4, step: 0.05, snap: 0, snapR: 0.08, get: () => (App.game ? App.game.fine : 0), set: v => App.game && App.game.setFine(v) });
  $('#btnShoot').onclick = () => { if (App.game) App.game.shoot(); };
  $('#btnSafety').onclick = () => { if (App.game) App.game.toggleSafety(); };
  $('#btnRack').onclick = () => { if (App.game) App.game.resetPractice(); };

  /* 抽屜（直向） */
  const isSideLayout = () => matchMedia('(min-aspect-ratio: 1/1) and (min-width: 821px)').matches;
  const gMain = () => document.querySelector('.g-main');
  const relayout = () => setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
  function openDrawer() { if (isSideLayout()) { gMain().classList.remove('collapsed'); relayout(); } else $('#gPanel').classList.add('open'); unread = 0; updateUnread(); }
  function closeDrawer() { if (isSideLayout()) { gMain().classList.add('collapsed'); relayout(); } else $('#gPanel').classList.remove('open'); }
  function resetDrawer() { $('#gPanel').classList.remove('open'); gMain().classList.toggle('collapsed', isSideLayout() && matchMedia('(max-height: 520px)').matches); relayout(); }   // 手機橫向：預設收起資訊欄
  $('#gDrawer').onclick = () => { if (isSideLayout()) return gMain().classList.contains('collapsed') ? openDrawer() : closeDrawer(); return $('#gPanel').classList.contains('open') ? closeDrawer() : openDrawer(); };
  $('#gPanelClose').onclick = closeDrawer;
  function updateUnread() {
    const b = $('#gUnread'); b.textContent = unread; b.classList.toggle('hidden', !unread);
    $('#gDrawerBadge').classList.toggle('hidden', !unread);
  }
  App.addUnread = function () { if (!$('#gPanel').classList.contains('open') || matchMedia('(min-aspect-ratio: 1/1) and (min-width: 821px)').matches) { /* 橫向時面板一直在 */ } if (!matchMedia('(min-aspect-ratio: 1/1) and (min-width: 821px)').matches && !$('#gPanel').classList.contains('open')) { unread++; updateUnread(); } };

  /* 返回 */
  $('#gBack').onclick = async () => {
    const g = App.game; const online = g && g.cfg && g.cfg.mode === 'online';
    const inGame = g && g.state && g.state.phase !== 'over';
    if (online) {
      const spectator = g.mySeat < 0;
      const ok = await confirmBox(spectator ? '離開觀戰？' : (inGame ? '離開對局？' : '離開房間？'), spectator ? '離開後可以從大廳再進來。' : (inGame ? '對局進行中離開會判負。' : '會回到大廳。'), '離開');
      if (!ok) return;
      root.PoolLobby.leaveRoom(); return;
    }
    if (inGame && g.cfg.mode === 'ai') { const ok = await confirmBox('離開對局？', '這局還沒打完，離開後不會記錄。', '離開'); if (!ok) return; }
    App.show(App.back === 'setup' ? 'setup' : 'home');
  };

  /* 結算 */
  function showResult(vm) {
    const ov = $('#resultOverlay');
    if (!vm) { ov.classList.add('hidden'); return; }
    const g = App.game, online = vm.mode === 'online';
    let title, badgeSeat = vm.winner;
    if (vm.draw) title = '平手'; else if (vm.spectator) title = vm.names[vm.winner] + ' 獲勝！'; else title = vm.youWin ? '你贏了！' : '你輸了';
    $('#resTitle').textContent = title;
    $('#resBadge').innerHTML = vm.draw ? '' : '<div class="avatar s' + vm.winner + '">' + esc(firstChar(vm.names[vm.winner])) + '</div>';
    $('#resReason').textContent = (vm.draw ? '' : vm.names[vm.winner] + ' 獲勝：') + vm.reason + '（' + vm.kindName + '，共 ' + vm.shots + ' 桿）';
    const s0 = vm.stats[0], s1 = vm.stats[1];
    const row = (a, m, b) => '<div class="v">' + a + '</div><div class="mid">' + m + '</div><div class="v">' + b + '</div>';
    $('#resStats').innerHTML = '<div class="head">' + esc(vm.names[0]) + '</div><div></div><div class="head">' + esc(vm.names[1]) + '</div>' +
      (vm.kind === 'score' ? row(vm.scores[0], '得分', vm.scores[1]) : '') + row(s0.potted, '進袋數', s1.potted) + row(s0.best, '最長連桿', s1.best) + row(s0.fouls, '犯規', s1.fouls);
    const again = $('#resAgain'), room = $('#resRoom'), home = $('#resHome');
    again.disabled = false; again.textContent = '再來一局';
    if (online) {
      room.textContent = '回到房間'; $('#resNote').textContent = vm.spectator ? '等玩家決定再來一局或回到房間。' : '按「再來一局」會互換開球權，對手也同意後立刻開始。';
      again.classList.toggle('hidden', vm.spectator); room.classList.toggle('hidden', false);
      again.onclick = () => { root.Net.send({ type: 'rematch' }); again.disabled = true; again.textContent = '等待對手同意…'; };
      room.onclick = () => root.Net.send({ type: 'tolobby' });
      home.onclick = () => root.PoolLobby.leaveRoom(true);
    } else {
      again.classList.remove('hidden'); room.classList.remove('hidden');
      room.textContent = '回到設定'; $('#resNote').textContent = '單機沒有房間，「回到設定」會回到規則與強度選擇。';
      again.onclick = () => { Sound.unlock(); App.game.nextGame(); };
      room.onclick = () => { App.show('setup'); };
      home.onclick = () => App.show('home');
    }
    home.textContent = '回到首頁';
    ov.classList.remove('hidden'); again.focus && !again.classList.contains('hidden') && again.focus();
  }
  App.updateRematch = function (room) {
    const ov = $('#resultOverlay'); if (ov.classList.contains('hidden') || !room) return;
    const again = $('#resAgain'); const me = room.members.find(m => m.id === root.Net.personId), opp = room.members.find(m => m.role === 'player' && m.id !== root.Net.personId);
    if (!me || me.role !== 'player') return;
    if (!opp || !opp.connected) { again.disabled = true; again.textContent = '對手已離開'; return; }
    if (opp.again && !me.again) { again.disabled = false; again.textContent = '對手想再來一局，按這裡同意'; }
    else if (me.again) { again.disabled = true; again.textContent = '等待對手同意…'; }
    else { again.disabled = false; again.textContent = '再來一局'; }
  };
  /* 選擇視窗 */
  let choiceTimer = 0;
  function showChoice(vm) {
    const ov = $('#choiceOverlay'); clearInterval(choiceTimer);
    if (!vm) { ov.classList.add('hidden'); return; }
    $('#chTitle').textContent = vm.title; $('#chDesc').textContent = vm.desc;
    const box = $('#chOpts'); box.innerHTML = '';
    vm.options.forEach((o, i) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (i === 0 ? ' gold' : ''); b.innerHTML = esc(o[1]) + '<small>' + esc(o[2]) + '</small>'; b.onclick = () => vm.onPick(o[0]); box.appendChild(b); });
    let left = vm.seconds; const tm = $('#chTimer');
    const tick = () => { tm.textContent = left != null ? '剩 ' + left + ' 秒，時間到會自動選：' + vm.options[(vm.title.indexOf('開球沒有達標') >= 0) ? 0 : 0][1] : ''; };
    if (left != null) { tick(); choiceTimer = setInterval(() => { left = Math.max(0, left - 1); tm.textContent = '剩 ' + left + ' 秒，時間到會自動選擇'; }, 1000); } else tm.textContent = '';
    ov.classList.remove('hidden'); box.firstChild.focus();
  }

  /* ---------- 首頁、說明 ---------- */
  function renderHomeStats() {
    const s = Store.get('stats');
    $('#homeStats').textContent = s.games ? '戰績：' + s.wins + ' 勝 ' + s.losses + ' 敗 ・ 最長連桿 ' + s.bestRun + ' 顆' : '';
  }
  $('#btnSolo').onclick = () => { Sound.unlock(); Sound.sfx.click(); setupKind = Store.get('lastKind'); setupMode = Store.get('lastMode'); setupLevel = Store.get('lastLevel'); App.show('setup'); };
  $('#btnOnline').onclick = () => { Sound.unlock(); Sound.sfx.click(); root.PoolLobby.enter(); };
  $('#btnHelp').onclick = () => { Sound.unlock(); Sound.sfx.click(); App.show('help'); };
  document.addEventListener('click', e => { const b = e.target.closest('[data-back]'); if (b) { Sound.sfx.click(); App.show(b.dataset.back); } });

  $('#helpBody').innerHTML = `
    <h3>基本操作</h3>
    <div class="card"><div class="kv">
      <b>瞄準</b><span>在桌面上任意處<b>拖曳</b>，球桿就會繞著母球轉。下方的「微調角度」可以做 0.05° 的精調。</span>
      <b>力度</b><span>拖曳「力度」條（左弱右強）。球桿後拉的距離會跟著變。</span>
      <b>擊球</b><span>按下大大的「擊球」按鈕才會出桿，拖曳與調力度都不會誤擊球。</span>
      <b>推桿／定桿／拉桿</b><span>擊球鈕左邊有三個快捷：<b>推桿</b>＝打母球偏上，碰到球後母球<b>繼續往前追</b>；<b>定桿</b>＝正撞時母球<b>停在原地</b>（做走位最常用）；<b>拉桿</b>＝打偏下，碰到球後母球<b>往回縮</b>。選了之後瞄準線的白色短線會即時顯示母球碰球後會跑去哪裡；再按一次同一個就取消。快鍵：1 推桿、2 定桿、3 拉桿、0 取消。</span>
      <b>跳桿</b><span>前面有球擋住路線時，按「<b>跳桿</b>」（快鍵 4）：母球會<b>飛過去</b>，落在瞄準線上黃色圈的位置才開始滾；飛行時碰不到地上的球、也不會掉進袋口。<b>力度越大飛得越遠</b>（約 130～460 單位），落地會損失一點速度，而且跳桿時不能同時用推／定／拉桿。落地後第一個碰到的球仍然要合規則，不然一樣算犯規。</span>
      <b>擊球點</b><span>點左下的「擊球點」，在母球上點一個位置：偏上＝出桿後追球、偏下＝縮球（拉回）、偏左右＝側旋，碰到庫邊會偏折。平常保持正中央就好。</span>
      <b>自由球</b><span>對手犯規後，你的母球會出現綠色虛線圈，可以拖曳到任何空位；紅色代表位置不合法。</span>
      <b>電腦鍵盤</b><span>← → 微調角度（Shift 更細）、↑ ↓ 力度、空白鍵或 Enter 擊球、滑鼠滾輪調力度。</span>
    </div></div>
    <h3>簡化九球</h3>
    <p>桌上有 1～9 號球。每一桿<b>必須先碰到桌上號碼最小的球</b>。把 9 號球打進袋就贏（開球或連桿中打進都算）；如果是犯規那一桿打進 9 號球，9 號球會放回置球點、不算贏。</p>
    <h3>八號球（正式規則）</h3>
    <ul>
      <li>開球後，<b>第一個合法進袋的球</b>決定你的花色：全色球（1～7）或半色球（9～15），對手拿另一種。</li>
      <li>開球要有球進袋，或至少有 4 顆球碰庫，否則犯規；這時對手可以選「接受現況」或「要求重擺重開」。</li>
      <li>開球時 8 號球進袋：開球者可選「重擺重開」或「8 號球放回置球點繼續打」。</li>
      <li>清完自己的花色後才能打 8 號球，而且要<b>先點選 8 號球要進的袋口</b>（金色虛線圈）。進了別的袋口、提早打進 8 號球、或犯規時打進 8 號球，都直接判負。</li>
      <li>犯規時對手取得自由球，犯規那一桿進袋的球不會放回桌面。</li>
    </ul>
    <h3>14-1 連續進球</h3>
    <p>每一桿都要<b>叫球</b>：先點要打的球，再點它要進的袋口（金色虛線圈）。叫的球進了指定袋口得 1 分，同一桿順便進袋的球也各得 1 分，而且可以繼續打；沒進指定袋口就不計分、進袋的球放回桌面並換手。覺得沒把握可以按<b>安全球</b>（先宣告，不計分也不扣分，換對手）。犯規扣 1 分、換手，對手取得自由球。先拿到 30 分獲勝。桌上只剩 1 顆球時，進袋的 14 顆會重新排成三角形（頂點空著），繼續打下去。開球不用叫球；幼幼班不用叫球也不扣分。</p>
    <h3>哪些情況是犯規？</h3>
    <ul><li>母球落袋</li><li>沒有碰到任何球</li><li>先碰到不該碰的球</li><li>碰球後沒有任何球進袋、也沒有任何球碰庫</li><li>線上對戰時回合超時</li></ul>
    <p>犯規的處罰：換對手出桿，而且對手可以把母球放在桌面任何空位（自由球）。</p>
    <h3>電腦強度</h3>
    <p>幼幼班（袋口放大、不判犯規）、簡單、普通、困難、神話。強度越高，電腦越準、越會避免犯規和安排走位。另外有「自由練習」可以自己打球、沒有壓力。</p>
    <h3>跟別人玩</h3>
    <p>只能兩個人對戰，不能和電腦對打。可以建立房間、用邀請連結叫朋友進來；房間滿了後來的人會變成<b>觀戰者</b>（最多 20 人）。對局中如果斷線，<b>30 秒內重連</b>會回到原本的位置，超過就判負。</p>`;

  /* ---------- 全域 ---------- */
  document.addEventListener('keydown', e => {
    if (App.screen !== 'game' || !App.game) return;
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (!$('#settingsModal').classList.contains('hidden') || !$('#confirmModal').classList.contains('hidden')) return;
    if (App.game.handleKey(e)) e.preventDefault();
  });
  document.addEventListener('pointerdown', () => Sound.unlock(), { once: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) Sound.stopMusic && Sound.stopMusic(); else if (Store.get('musicOn')) Sound.unlock(); });
  $$('.screen .btn, .modal .btn').forEach(() => {});
  document.addEventListener('click', e => { if (e.target.closest('.btn') && !e.target.closest('.shoot')) Sound.sfx.click(); }, true);

  applySettings();
  renderHomeStats();
  App.show('home');
  root.PoolLobby && root.PoolLobby.init && root.PoolLobby.init();
})(typeof self !== 'undefined' ? self : this);
