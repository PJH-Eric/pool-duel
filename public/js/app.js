/* 介面總管：首頁（會自己打球的桌面）、單機設定、設定視窗、說明、對局介面。 */
(function (root) {
  'use strict';
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const Store = root.Store, Sound = root.Sound, Rules = root.PoolRules, AI = root.PoolAI, P = root.PoolPhysics, C = root.PoolConfig, Themes = root.PoolThemes, RNG = root.RNG;
  const T = (k, p) => root.I18N.t(k, p);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const firstChar = n => Array.from(String(n || '?'))[0] || '?';
  const App = { screen: 'home', game: null, back: 'home', setupNote: '' };
  const gameStatus = root.PoolGameStatus.create(view => {
    const el = $('#gStatus');
    el.textContent = view.text;
    el.classList.toggle('mine', view.mine);
    el.classList.toggle('toast-message', view.kind === 'message');
    el.classList.toggle('toast-foul', view.kind === 'foul');
  });
  root.PoolApp = App;

  /* ---------- 小工具 ---------- */
  let gtT = 0;
  App.toast = function (text, ms) {
    if (App.screen === 'game' && App.game && App.game.ui && App.game.ui.toast) { App.game.ui.toast(text); return; }   // 對局中提示顯示在球員資訊列
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
      const m = $('#confirmModal'); $('#cfTitle').textContent = title; $('#cfText').textContent = text; $('#cfYes').textContent = yesLabel || T('common.ok');
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
    { g: 'set.g.language' },
    { k: '_lang', t: 'lang', b: 'set.language', d: 'set.languageDesc' },
    { g: 'set.g.sound' },
    { k: 'musicOn', t: 'toggle', b: 'set.music', d: 'set.musicDesc' },
    { k: 'musicVol', t: 'slider', b: 'set.musicVol' },
    { k: 'sfxOn', t: 'toggle', b: 'set.sfx', d: 'set.sfxDesc' },
    { k: 'sfxVol', t: 'slider', b: 'set.sfxVol' },
    { k: 'vibrate', t: 'toggle', b: 'set.vibrate', d: 'set.vibrateDesc' },
    { g: 'set.g.control' },
    { k: 'aim', t: 'seg', b: 'set.aim', d: 'set.aimDesc', opts: [['full', 'opt.aim.full'], ['short', 'opt.aim.short'], ['off', 'opt.aim.off']] },
    { k: 'showSpin', t: 'toggle', b: 'set.showSpin', d: 'set.showSpinDesc' },
    { k: 'swapControls', t: 'toggle', b: 'set.swap', d: 'set.swapDesc' },
    { g: 'set.g.display' },
    { k: 'bigNumbers', t: 'toggle', b: 'set.bigNumbers', d: 'set.bigNumbersDesc' },
    { k: 'colorAssist', t: 'toggle', b: 'set.colorAssist', d: 'set.colorAssistDesc' },
    { k: 'reduceMotion', t: 'toggle', b: 'set.reduceMotion', d: 'set.reduceMotionDesc' },
    { g: 'set.g.felt' },
    { k: 'felt', t: 'swatch', al: 'set.g.felt', opts: Object.keys(Themes.FELTS).map(k => [k, 'felt.' + k, 'background:radial-gradient(circle at 40% 35%,' + Themes.FELTS[k].c1 + ',' + Themes.FELTS[k].c3 + ')']) },
    { g: 'set.g.scene' },
    { k: 'scene', t: 'swatch', al: 'set.g.scene', opts: Object.keys(Themes.SCENES).map(k => [k, 'scene.' + k, 'background:linear-gradient(' + Themes.SCENES[k].top + ',' + Themes.SCENES[k].bottom + ')']) },
    { g: 'set.g.cue' },
    { k: 'cue', t: 'swatch', cue: true, al: 'set.g.cue', opts: Object.keys(Themes.CUES).map(k => [k, 'cue.' + k, '', Themes.CUES[k]]) }
  ];
  let settingsOpener = null;
  function buildSettings() {
    const body = $('#setBody'); body.innerHTML = '';
    SETTINGS_DEF.forEach(def => {
      if (def.g) { const g = document.createElement('div'); g.className = 'set-group'; g.textContent = T(def.g); body.appendChild(g); return; }
      const row = document.createElement('div'); row.className = 'set-row'; row.dataset.k = def.k;
      if (def.t === 'swatch') {
        const box = document.createElement('div'); box.className = 'swatches'; box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', T(def.al));
        def.opts.forEach(o => {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch'; b.setAttribute('role', 'radio'); b.dataset.v = o[0];
          const style = def.cue ? '--tip:' + o[3].tip + ';--shaft:' + o[3].shaft + ';--butt:' + o[3].butt + ';background:#2a1a10' : o[2];
          b.innerHTML = '<span class="sw' + (def.cue ? ' cue' : '') + '" style="' + style + '"></span>' + esc(T(o[1]));
          b.onclick = () => { Store.set(def.k, o[0]); Sound.sfx.click(); syncSettings(); };
          box.appendChild(b);
        });
        row.style.display = 'block'; row.appendChild(box);
      } else {
        const tx = document.createElement('div'); tx.className = 'tx'; tx.innerHTML = '<b>' + esc(T(def.b)) + '</b>' + (def.d ? '<span>' + esc(T(def.d)) + '</span>' : '');
        row.appendChild(tx);
        if (def.t === 'toggle') {
          const t = document.createElement('button'); t.type = 'button'; t.className = 'toggle'; t.setAttribute('role', 'switch'); t.setAttribute('aria-label', T(def.b));
          t.onclick = () => { Store.set(def.k, !Store.get(def.k)); Sound.unlock(); Sound.sfx.click(); syncSettings(); };
          row.appendChild(t);
        } else if (def.t === 'slider') {
          const s = document.createElement('div'); s.className = 'slider set-slider'; s.setAttribute('role', 'slider'); s.setAttribute('aria-label', T(def.b)); s.tabIndex = 0;
          s.innerHTML = '<div class="knob"></div>'; row.appendChild(s);
          bindSlider(s, { min: 0, max: 1, step: 0.05, get: () => Store.get(def.k), set: v => { Store.set(def.k, v); Sound.unlock(); }, end: () => Sound.sfx.click() });
        } else if (def.t === 'lang') {
          const sg = document.createElement('div'); sg.className = 'seg'; sg.setAttribute('role', 'radiogroup'); sg.setAttribute('aria-label', T(def.b));
          [['zh-Hant', '繁體中文'], ['en', 'English']].forEach(o => { const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-b'; b.setAttribute('role', 'radio'); b.dataset.v = o[0]; b.setAttribute('lang', o[0] === 'en' ? 'en' : 'zh-Hant'); b.textContent = o[1]; b.onclick = () => { root.I18N.setLang(o[0]); }; sg.appendChild(b); });
          row.appendChild(sg);
        } else if (def.t === 'seg') {
          const sg = document.createElement('div'); sg.className = 'seg'; sg.setAttribute('role', 'radiogroup'); sg.setAttribute('aria-label', T(def.b));
          def.opts.forEach(o => { const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-b'; b.setAttribute('role', 'radio'); b.dataset.v = o[0]; b.textContent = T(o[1]); b.onclick = () => { Store.set(def.k, o[0]); Sound.sfx.click(); syncSettings(); }; sg.appendChild(b); });
          row.appendChild(sg);
        }
      }
      body.appendChild(row);
    });
    syncSettings();
  }
  function syncSettings() {
    $$('#setBody .set-row').forEach(row => {
      const k = row.dataset.k, v = k === '_lang' ? root.I18N.lang : Store.get(k);
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
  $('#setReset').onclick = () => { Store.reset(); buildSettings(); applySettings(); App.toast(T('toast.resetDone')); };
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
    { id: 'nine', ball: '#f0be1e', stripe: true },
    { id: 'eight', ball: '#17171a' },
    { id: 'score', ball: '#d8322a' }
  ];
  const LEVEL_IDS = ['kids', 'easy', 'normal', 'hard', 'myth'];
  let setupKind = 'nine', setupMode = 'ai', setupLevel = 'easy';
  function refreshSetup() {
    const box = $('#kindCards'); box.innerHTML = '';
    KIND_INFO.forEach(k => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'kcard'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', k.id === setupKind ? 'true' : 'false');
      const ballStyle = k.stripe ? 'background:linear-gradient(' + k.ball + ' 0 28%,#f6f1e4 28% 72%,' + k.ball + ' 72%)' : 'background:' + k.ball;
      b.innerHTML = '<div class="k-top"><span class="kball" style="' + ballStyle + '"></span><span class="k-name">' + T('kind.' + k.id + '.name') + '</span><span class="k-tag">' + T('kind.' + k.id + '.tag') + '</span></div><p>' + T('kind.' + k.id + '.desc') + '</p>';
      b.onclick = () => { setupKind = k.id; Sound.sfx.click(); refreshSetup(); };
      box.appendChild(b);
    });
    $$('#modeSeg .seg-b').forEach(b => { b.setAttribute('aria-checked', b.dataset.v === setupMode ? 'true' : 'false'); b.onclick = () => { setupMode = b.dataset.v; Sound.sfx.click(); refreshSetup(); }; });
    const ls = $('#levelSeg'); ls.innerHTML = '';
    LEVEL_IDS.forEach(id => { const l = { id }; const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-b'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', l.id === setupLevel ? 'true' : 'false'); b.textContent = T('level.' + id + '.name'); b.onclick = () => { setupLevel = l.id; Sound.sfx.click(); refreshSetup(); }; ls.appendChild(b); });
    $('#levelNote').textContent = T('level.' + setupLevel + '.note');
    $('#levelBox').classList.toggle('hidden', setupMode !== 'ai');
    $('#practiceNote').classList.toggle('hidden', setupMode !== 'practice');
    $('#btnStartSolo').textContent = setupMode === 'ai' ? T('setup.startAi') : T('setup.startPractice');
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
    const you = Store.get('nickname') || T('seat.you');
    const seats = cfg.mode === 'practice' ? [{ name: you }, { name: T('seat.practice'), key: 'seat.practice' }] : [{ name: you }, { name: T('seat.ai', { level: T('level.' + cfg.level + '.name') }), key: 'seat.ai', level: cfg.level }];
    $('#gChatBox').classList.add('hidden'); $('#gSpec').classList.add('hidden');
    $('#gPanel').classList.add('hidden'); $('#gDrawer').classList.add('hidden');
    $('#btnRack').classList.toggle('hidden', cfg.mode !== 'practice');
    g.practiceCount = 0;
    GameAnalytics.start({ mode: cfg.mode, difficulty: cfg.level, players: cfg.mode === 'practice' ? 1 : 2 });
    g.start({ mode: cfg.mode, kind: cfg.kind, level: cfg.mode === 'practice' ? 'kids' : cfg.level, mySeat: 0, seats, bigPockets: cfg.level === 'kids' });
    applySettings();
    resetDrawer();
  };
  App.startOnlineGame = function (gameMsg, room, extra) {
    App.show('game');
    const g = ensureGame(); g.resume();
    $('#btnRack').classList.add('hidden');
    $('#gChatBox').classList.remove('hidden');
    $('#gPanel').classList.remove('hidden'); $('#gDrawer').classList.remove('hidden');
    const me = room.youSeat;
    if (me >= 0) GameAnalytics.start({ mode: 'online', players: 2 });
    g.start({ mode: 'online', kind: gameMsg.kind, mySeat: me, state: gameMsg.state, seats: gameMsg.seats.map(s => ({ name: s.name })), cues: gameMsg.seats.map(s => s.cue), aimMode: gameMsg.cfg.aim, net: root.Net, turnMs: gameMsg.turnMs, extensionUsed: gameMsg.extensionUsed, bigPockets: gameMsg.cfg.pockets === 'big' });
    $('#gSpec').classList.toggle('hidden', me >= 0);
    $('#gSpec').textContent = T('game.specNote');
    applySettings(); resetDrawer(); unread = 0; updateUnread();
  };

  const seatHtml = (s, mini) => {
    return '<div class="avatar s' + s.seat + (mini ? ' sm' : '') + '" aria-hidden="true">' + esc(firstChar(s.name)) + '</div>';
  };
  function miniBall(id, out, next) {
    const col = Themes.ballColor(id);
    const style = id >= 9 ? 'background:linear-gradient(' + col + ' 0 28%,#f6f1e4 28% 72%,' + col + ' 72%)' : 'background:' + col;
    return '<span class="mini-ball' + (out ? ' out' : '') + (next ? ' next' : '') + '" style="' + style + '" title="' + esc(T('hud.ballNo', { n: id })) + '"><b>' + id + '</b></span>';
  }
  App.ui = {
    hud(vm) {
      const resolvingShot = ['strike', 'roll', 'settle'].includes(vm.phase);
      const text = resolvingShot ? T('hud.resolving') : vm.status;
      const mine = !resolvingShot && !!vm.statusMine;
      gameStatus.update(text, mine, vm.statusRevision + ':' + vm.phase);
      let html = '';
      vm.seats.forEach(s => {
        const tag = s.you ? '<span class="tag">' + esc(T('hud.you')) + '</span>' : '';
        const right = vm.kind === 'score' ? '<span class="pscore">' + s.score + '</span>' : '';
        const subtitle = vm.kind === 'score' ? s.line2 : [s.line1, s.line2].filter(Boolean).join(' ・ ');
        const potted = s.pottedBalls || [];
        const historyLabel = potted.length ? T('hud.pottedList', { list: potted.map(id => T('hud.ballN', { n: id })).join(T('common.sep')) }) : T('hud.pottedNone');
        const history = potted.length ? potted.map(id => miniBall(id)).join('') : '<span class="potted-empty">' + esc(T('hud.pottedNone')) + '</span>';
        html += '<div class="pseat seat-' + s.seat + (s.isTurn ? ' turn' : '') + '">' + seatHtml(s) + '<div class="pseat-info"><div class="pname"><span class="n">' + esc(s.name) + '</span>' + tag + right + '</div><div class="pline">' + esc(subtitle) + '</div></div>' +
          '<div class="potted-row"><span class="potted-label">' + esc(T('hud.potted')) + '</span><div class="potted-history" role="img" aria-label="' + esc(historyLabel) + '">' + history + '</div></div></div>';
      });
      $('#gSeats').innerHTML = html;
    },
    controls(c) {
      const dis = !c.enabled;
      $('#btnShoot').disabled = !c.canShoot;
      $('#btnSafety').classList.toggle('hidden', !c.safetyBtn); $('#btnSafety').setAttribute('aria-pressed', c.safety ? 'true' : 'false');
      $('#fineSlider').classList.toggle('off', dis); $('#powerSlider').classList.toggle('off', dis);
      $('#spinBtn').disabled = dis; $$('#cueModes button').forEach(b => { b.disabled = dis; }); $('#gControls').classList.toggle('spectate', !!c.spectator);
      $('#btnShoot').textContent = c.spectator ? T('ctl.watching') : (c.needCall && !c.canShoot ? T('ctl.callFirst') : (c.thinking ? T('ctl.thinking') : T('ctl.shoot')));
    },
    power(p) { $('#powerVal').textContent = Math.round(p * 100) + '%'; powerSlider.render(); },
    fine(d) { $('#fineVal').textContent = (d >= 0 ? '+' : '') + d.toFixed(2) + '°'; fineSlider.render(); },
    spin(u, v) { setSpinDot(u, v); },
    toast(text, kind) { gameStatus.toast(text, kind); },
    timer(sec, mine) {
      const el = $('#gTimer'), wrap = $('#gTimerWrap');
      if (sec == null) { el.textContent = '--'; el.classList.remove('low'); return; }
      el.textContent = sec; el.classList.toggle('low', !!mine && sec <= 5);
    },
    extension(vm) {
      const button = $('#btnExtend');
      button.disabled = !vm.enabled;
      button.textContent = vm.pending ? '…' : (vm.used ? T('hud.extUsed') : '+25');
      button.classList.toggle('spent', vm.used);
      const label = vm.used ? T('hud.extendUsedAria') : T('hud.extendAria');
      button.setAttribute('aria-label', label);
      button.title = label;
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
  const MODE_NOTE = m => T('mode.' + m + 'Note'), MODE_NAME = m => T('mode.' + m);
  const smallScreen = () => matchMedia('(max-aspect-ratio: 1/1), (max-width: 820px), (max-height: 520px)').matches;
  function placeModes() {            // 小螢幕：四顆出桿按鈕收進擊球點面板；大螢幕：放在擊球點旁
    const box = $('#cueModes'), pop = $('#spinPop'), ctl = document.querySelector('.spin-ctl');
    if (smallScreen()) { if (box.parentNode !== pop) pop.insertBefore(box, pop.querySelector('.spin-tip')); }
    else if (box.parentNode !== ctl) ctl.appendChild(box);
  }
  window.addEventListener('resize', placeModes); placeModes();
  function syncCueModes() { const m = App.game && App.game.cueMode ? App.game.cueMode() : null; $$('#cueModes button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === m ? 'true' : 'false')); const lb = document.querySelector('#spinBtn .lbl'); if (lb) lb.textContent = m ? MODE_NAME(m) : T('ctl.spin'); }
  $$('#cueModes button').forEach(b => { b.onclick = () => { const g = App.game; if (!g) return; g.setCueMode(b.dataset.mode); const m = g.cueMode(); if (m && g.ui.toast) g.ui.toast(MODE_NOTE(m)); }; });
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
  $('#btnExtend').onclick = () => { if (App.game) App.game.extendTime(); };
  $('#btnSafety').onclick = () => { if (App.game) App.game.toggleSafety(); };
  $('#btnRack').onclick = () => { if (App.game) App.game.resetPractice(); };

  /* 聊天室：寬螢幕固定在左側，小螢幕改用抽屜 */
  const isChatDrawerLayout = () => matchMedia('(max-aspect-ratio: 1/1), (max-width: 820px), (max-height: 520px)').matches;
  let hudLayoutFrame = 0;
  function syncHudTableLayout() {
    if (hudLayoutFrame) cancelAnimationFrame(hudLayoutFrame);
    hudLayoutFrame = requestAnimationFrame(() => {
      hudLayoutFrame = 0;
      const game = App.game, screen = $('#screen-game');
      if (!game || !screen.classList.contains('active') || !game.r.state.s) return;
      const canvasRect = $('#gCanvas').getBoundingClientRect();
      // 提示換行或資訊欄尺寸改變時，同步繪圖與瞄準座標使用的球檯比例。
      if (game.r.state.w !== Math.round(canvasRect.width) || game.r.state.h !== Math.round(canvasRect.height)) game.r.resize();
      const layout = game.r.state;
      const tableWidth = ((layout.portrait ? C.H : C.W) + game.r.FR * 2) * layout.s;
      const tableCenter = canvasRect.left + layout.ox + tableWidth / 2;
      const screenRect = screen.getBoundingClientRect(), screenStyle = getComputedStyle(screen);
      const contentLeft = screenRect.left + parseFloat(screenStyle.paddingLeft || 0);
      const contentWidth = screenRect.width - parseFloat(screenStyle.paddingLeft || 0) - parseFloat(screenStyle.paddingRight || 0);
      const contentCenter = contentLeft + contentWidth / 2;
      screen.style.setProperty('--hud-board-width', tableWidth + 'px');
      screen.style.setProperty('--hud-board-shift', (tableCenter - contentCenter) + 'px');
    });
  }
  const hudResizeObserver = 'ResizeObserver' in root ? new root.ResizeObserver(syncHudTableLayout) : null;
  if (hudResizeObserver) hudResizeObserver.observe($('#gCanvas'));
  function syncChatLayout() {
    const online = App.game && App.game.cfg && App.game.cfg.mode === 'online';
    const main = document.querySelector('.g-main'), panel = $('#gPanel'), button = $('#gDrawer');
    if (!online) {
      main.classList.remove('with-chat'); panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true');
      button.classList.add('hidden'); button.setAttribute('aria-expanded', 'false');
      syncHudTableLayout();
      return;
    }
    const compact = isChatDrawerLayout();
    main.classList.toggle('with-chat', !compact);
    button.classList.toggle('hidden', !compact);
    if (!compact) {
      panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'false');
      button.setAttribute('aria-expanded', 'true');
      syncHudTableLayout();
      return;
    }
    const open = panel.classList.contains('open');
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncHudTableLayout();
  }
  function openDrawer() {
    $('#gPanel').classList.add('open'); $('#gPanel').setAttribute('aria-hidden', 'false');
    $('#gDrawer').setAttribute('aria-expanded', 'true'); unread = 0; updateUnread();
  }
  function closeDrawer() {
    $('#gPanel').classList.remove('open'); $('#gPanel').setAttribute('aria-hidden', 'true');
    $('#gDrawer').setAttribute('aria-expanded', 'false');
  }
  function resetDrawer() { closeDrawer(); unread = 0; updateUnread(); syncChatLayout(); }
  $('#gDrawer').onclick = () => $('#gPanel').classList.contains('open') ? closeDrawer() : openDrawer();
  $('#gPanelClose').onclick = closeDrawer;
  window.addEventListener('resize', () => { syncChatLayout(); syncHudTableLayout(); });
  function updateUnread() {
    const b = $('#gUnread'); b.textContent = unread; b.classList.toggle('hidden', !unread);
    $('#gDrawerBadge').classList.toggle('hidden', !unread);
  }
  App.addUnread = function () { if (isChatDrawerLayout() && !$('#gPanel').classList.contains('open')) { unread++; updateUnread(); } };

  /* 返回 */
  $('#gBack').onclick = async () => {
    const g = App.game; const online = g && g.cfg && g.cfg.mode === 'online';
    const inGame = g && g.state && g.state.phase !== 'over';
    if (online) {
      const spectator = g.mySeat < 0;
      const ok = await confirmBox(spectator ? T('leave.specTitle') : (inGame ? T('leave.gameTitle') : T('leave.roomTitle')), spectator ? T('leave.specText') : (inGame ? T('leave.gameText') : T('leave.roomText')), T('leave.yes'));
      if (!ok) return;
      root.PoolLobby.leaveRoom(); return;
    }
    if (inGame && g.cfg.mode === 'ai') { const ok = await confirmBox(T('leave.gameTitle'), T('leave.soloText'), T('leave.yes')); if (!ok) return; }
    App.show(App.back === 'setup' ? 'setup' : 'home');
  };

  /* 結算 */
  function showResult(vm) {
    const ov = $('#resultOverlay');
    if (!vm) { ov.classList.add('hidden'); return; }
    if (!vm.spectator) GameAnalytics.end({ result: vm.draw ? 'draw' : (vm.youWin ? 'win' : 'lose') });
    const online = vm.mode === 'online', wasHidden = ov.classList.contains('hidden');
    let title;
    if (vm.draw) title = T('res.draw'); else if (vm.spectator) title = T('res.specWin', { name: vm.names[vm.winner] }); else title = vm.youWin ? T('res.youWin') : T('res.youLose');
    $('#resTitle').textContent = title;
    $('#resBadge').innerHTML = vm.draw ? '' : '<div class="avatar s' + vm.winner + '">' + esc(firstChar(vm.names[vm.winner])) + '</div>';
    $('#resReason').textContent = T('res.reasonLine', { who: vm.draw ? '' : T('res.whoWins', { name: vm.names[vm.winner] }), reason: vm.reason, kind: vm.kindName, shots: vm.shots });
    const s0 = vm.stats[0], s1 = vm.stats[1];
    const row = (a, m, b) => '<div class="v">' + a + '</div><div class="mid">' + esc(m) + '</div><div class="v">' + b + '</div>';
    $('#resStats').innerHTML = '<div class="head">' + esc(vm.names[0]) + '</div><div></div><div class="head">' + esc(vm.names[1]) + '</div>' +
      (vm.kind === 'score' ? row(vm.scores[0], T('res.score'), vm.scores[1]) : '') + row(s0.potted, T('res.potted'), s1.potted) + row(s0.best, T('res.bestRun'), s1.best) + row(s0.fouls, T('res.fouls'), s1.fouls);
    const again = $('#resAgain'), room = $('#resRoom'), home = $('#resHome');
    again.disabled = false; again.textContent = T('res.again');
    if (online) {
      room.textContent = T('res.room'); $('#resNote').textContent = vm.spectator ? T('res.noteSpec') : T('res.noteOnline');
      again.classList.toggle('hidden', vm.spectator); room.classList.toggle('hidden', false);
      again.onclick = () => { root.Net.send({ type: 'rematch' }); again.disabled = true; again.textContent = T('res.waitOpp'); };
      room.onclick = () => root.Net.send({ type: 'tolobby' });
      home.onclick = () => root.PoolLobby.leaveRoom(true);
    } else {
      again.classList.remove('hidden'); room.classList.remove('hidden');
      room.textContent = T('res.toSetup'); $('#resNote').textContent = T('res.noteSolo');
      again.onclick = () => { Sound.unlock(); App.game.nextGame(); };
      room.onclick = () => { App.show('setup'); };
      home.onclick = () => App.show('home');
    }
    home.textContent = T('res.home');
    ov.classList.remove('hidden'); if (wasHidden) again.focus && !again.classList.contains('hidden') && again.focus();
  }
  App.updateRematch = function (room) {
    const ov = $('#resultOverlay'); if (ov.classList.contains('hidden') || !room) return;
    const again = $('#resAgain'); const me = room.members.find(m => m.id === root.Net.personId), opp = room.members.find(m => m.role === 'player' && m.id !== root.Net.personId);
    if (!me || me.role !== 'player') return;
    if (!opp || !opp.connected) { again.disabled = true; again.textContent = T('res.oppLeft'); return; }
    if (opp.again && !me.again) { again.disabled = false; again.textContent = T('res.oppWants'); }
    else if (me.again) { again.disabled = true; again.textContent = T('res.waitOpp'); }
    else { again.disabled = false; again.textContent = T('res.again'); }
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
    const tick = () => { tm.textContent = left != null ? T('choice.timerFirst', { n: left, opt: vm.options[0][1] }) : ''; };
    if (left != null) { tick(); choiceTimer = setInterval(() => { left = Math.max(0, left - 1); tm.textContent = T('choice.timer', { n: left }); }, 1000); } else tm.textContent = '';
    ov.classList.remove('hidden'); box.firstChild.focus();
  }

  /* ---------- 首頁、說明 ---------- */
  function renderHomeStats() {
    const s = Store.get('stats');
    $('#homeStats').textContent = s.games ? T('home.stats', { w: s.wins, l: s.losses, run: s.bestRun }) : '';
  }
  $('#btnSolo').onclick = () => { Sound.unlock(); Sound.sfx.click(); setupKind = Store.get('lastKind'); setupMode = Store.get('lastMode'); setupLevel = Store.get('lastLevel'); App.show('setup'); };
  $('#btnOnline').onclick = () => { Sound.unlock(); Sound.sfx.click(); root.PoolLobby.enter(); };
  $('#btnHelp').onclick = () => { Sound.unlock(); Sound.sfx.click(); App.show('help'); };
  document.addEventListener('click', e => { const b = e.target.closest('[data-back]'); if (b) { Sound.sfx.click(); App.show(b.dataset.back); } });

  /* 說明內容在 locales.js（help.body），由 data-i18n-html 套用 */

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

  /* 語言切換：只重繪文字，不重置對局狀態 */
  root.I18N.onChange(() => {
    renderHomeStats();
    if (App.screen === 'setup') refreshSetup();
    if (!$('#settingsModal').classList.contains('hidden')) {
      buildSettings();
      const cur = document.querySelector('#setBody [data-k="_lang"] .seg-b[aria-checked="true"]'); if (cur) cur.focus();
    }
    syncCueModes();
    Latency.refresh();
    if (App.game) App.game.relocalize();
    else $('#btnShoot').textContent = T('ctl.shoot');
    const rm = root.PoolLobby && root.PoolLobby.room; if (rm && App.updateRematch) App.updateRematch(rm);
    if (root.PoolLobby && root.PoolLobby.relocalize) root.PoolLobby.relocalize();
  });
  /* 設定鈕旁的語言切換鈕：每個畫面的設定鈕各一顆，狀態由 I18N 同步 */
  $$('#homeGear, [data-gear]').forEach(g => root.I18N.mountToggle({ after: g, id: 'b-lang-' + (g.id || (g.closest('.screen') || {}).id || 'x'), className: 'btn round' }));
  applySettings();
  renderHomeStats();
  App.show('home');
  root.PoolLobby && root.PoolLobby.init && root.PoolLobby.init();
})(typeof self !== 'undefined' ? self : this);
