/* 對局控制：輸入（拖曳瞄準、力度、擊球點、自由球、指定袋口）、出桿動畫、物理重播、
   單機電腦流程、線上同步（收到 shot 就用同一份引擎本地播放，收到 settle 以伺服器為準）。 */
(function (root) {
  'use strict';
  const C = root.PoolConfig, P = root.PoolPhysics, Rules = root.PoolRules, AI = root.PoolAI, RNG = root.RNG, Render = root.PoolRender, Sound = root.Sound;
  const REASON = {
    nine: '9 號球合法進袋', eight: '8 號球打進指定袋口', score: '先拿到目標分數', draw: '平手',
    disconnect: '對手斷線逾時', forfeit: '對手離開了'
  };
  const EIGHT_LOSS = { open: '開放桌面時 8 號球進袋', foul: '犯規桿打進 8 號球', early: '還沒清完花色就打進 8 號球', pocket: '8 號球進了非指定袋口' };
  const rad = d => d * Math.PI / 180;

  class Game {
    constructor(canvas, ui, store) {
      this.canvas = canvas; this.ui = ui; this.store = store;
      this.r = Render.create(canvas);
      this.raf = 0; this.last = 0; this.running = false;
      this.state = null; this.world = null; this.cfg = null;
      this.phase = 'idle';                  // idle | aiming | waiting | thinking | strike | roll | choice | over
      this.statusRevision = 0;
      this.statusState = null;
      this.angle = 0; this.fine = 0; this.power = 0.5; this.spin = { u: 0, v: 0 }; this.jump = false;
      this.call = -1; this.callBall = -1; this.safety = false; this.hand = null; this.dragMode = null;
      this.dropping = []; this.queue = []; this.pendingSettle = null; this.provisional = false;
      this.remoteAim = null; this.curShot = null; this.anim = null; this.aiAnim = null;
      this.lastAimSent = 0; this.turnEnd = 0; this.lastSec = -1; this.awaitEcho = false;
      this.stats = null; this.timers = [];
      this._onResize = () => { this.r.resize(); };
      root.addEventListener('resize', this._onResize);
      this._bindPointer();
    }

    /* ---------- 生命週期 ---------- */
    start(cfg) {
      this.cfg = Object.assign({ mode: 'ai', kind: 'nine', level: 'easy', mySeat: 0, aimMode: 'full', seats: [{ name: '你' }, { name: '電腦' }] }, cfg);
      this.clearTimers(); this.queue = []; this.pendingSettle = null; this.world = null; this.dropping = []; this.curShot = null; this.awaitEcho = false; this.provisional = false;
      this.stats = [0, 1].map(() => ({ shots: 0, potted: 0, pottedBalls: [], fouls: 0, run: 0, best: 0 }));
      this.statusState = null;
      this.rng = RNG.create(this.cfg.seed || RNG.newSeed());
      this.mySeat = this.cfg.mySeat;
      this.r.setTheme({ felt: this.store.get('felt'), scene: this.store.get('scene'), cue: this.store.get('cue'), bigNumbers: this.store.get('bigNumbers') });
      this.r.resetRolls(); this.r.resize();
      this.power = 0.5; this.fine = 0; this.spin = { u: 0, v: 0 }; this.jump = false;
      this.ui.spin && this.ui.spin(0, 0); this.ui.power && this.ui.power(this.power); this.ui.fine && this.ui.fine(0);   // 新局一開始就把力度條、微調、擊球點畫面同步成真正的預設值
      if (this.cfg.state) this.state = this.cfg.state;
      else {
        const kids = this.cfg.level === 'kids';
        this.state = Rules.newGame(this.cfg.kind, { breaker: this.cfg.mode === 'ai' ? 0 : 0, kids: kids || this.cfg.mode === 'practice', bigPockets: !!this.cfg.bigPockets || kids }, this.rng);
        if (this.cfg.mode === 'ai' && this.cfg.breaker != null) { this.state.breaker = this.cfg.breaker; this.state.turn = this.cfg.breaker; this.state.hand.player = this.cfg.breaker; }
      }
      this.r.setPocketScale(this.state.bigPockets ? C.POCKET_SCALE_BIG : 1);
      this.turnEnd = this.cfg.turnMs ? performance.now() + this.cfg.turnMs : 0;
      if (!this.running) { this.running = true; this.last = performance.now(); this.raf = requestAnimationFrame(t => this.frame(t)); }
      this.ui.result && this.ui.result(null); this.ui.choice && this.ui.choice(null);
      this.beginTurn(true);
    }
    destroy() {
      this.running = false; cancelAnimationFrame(this.raf); this.clearTimers();
      root.removeEventListener('resize', this._onResize);
    }
    stop() { this.running = false; cancelAnimationFrame(this.raf); this.clearTimers(); this.phase = 'idle'; }
    resume() { if (!this.running) { this.running = true; this.last = performance.now(); this.raf = requestAnimationFrame(t => this.frame(t)); this.r.resize(); } }
    after(ms, fn) { const id = setTimeout(() => { this.timers = this.timers.filter(x => x !== id); fn(); }, ms); this.timers.push(id); return id; }
    clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; }

    get isOnline() { return this.cfg && this.cfg.mode === 'online'; }
    get isMyTurn() { return this.state && this.state.phase === 'play' && this.state.turn === this.mySeat && this.mySeat >= 0; }
    seatName(i) { return (this.cfg.seats[i] && this.cfg.seats[i].name) || ('P' + (i + 1)); }

    /* ---------- 回合開始 ---------- */
    beginTurn(initial) {
      this.statusRevision++;
      const s = this.state; this.call = -1; this.callBall = -1; this.safety = false; this.hand = null; this.remoteAim = null;
      if (s.phase === 'over') { this.phase = 'over'; this.refresh(); this.showResult(); return; }
      if (s.phase === 'choice') { this.phase = 'choice'; this.refresh(); this.handleChoice(); return; }
      this.ui.choice && this.ui.choice(null);
      const handOwner = s.hand ? s.hand.player : -1;
      if (this.isMyTurn) {
        this.phase = 'aiming';
        if (s.hand && handOwner === this.mySeat) { const c = s.balls[0]; this.hand = { x: c.x, y: c.y, ok: Rules.validCuePlacement(s, c.x, c.y), last: { x: c.x, y: c.y } }; }
        this.defaultAim();
        this.refresh();
        if (!initial) Sound.sfx.turn();
      } else if (this.cfg.mode === 'ai' && s.turn !== this.mySeat) {
        this.phase = 'thinking'; this.refresh(); this.scheduleAI();
      } else { this.phase = 'waiting'; this.refresh(); }
      this.sendAim(true);
    }

    defaultAim() {
      const s = this.state, c = this.cuePos();
      let best = null, bd = 1e9;
      const ids = s.isBreak ? [] : Rules.legalFirstIds(s);
      if (s.isBreak) { this.angle = Math.atan2(C.CENTER_Y - c.y, C.FOOT_X - c.x); this.fine = 0; this.ui.fine && this.ui.fine(0); return; }
      const cands = AI.potCandidates(s, c);              // 優先對準「球→袋口」的進球線（鬼球位置），不是只對準球心
      if (cands.length) {
        const k = cands[0];
        this.angle = Math.atan2(k.dir.y, k.dir.x); this.fine = 0; this.ui.fine && this.ui.fine(0);
        if (Rules.needCall(s)) this.call = k.pocket;
        else if (Rules.needCallBall(s)) { this.callBall = k.target; this.call = k.pocket; }
        return;
      }
      for (const id of ids) {
        const b = Rules.getBall(s, id); if (!b || b.pocket >= 0) continue;
        const d = Math.hypot(b.x - c.x, b.y - c.y); if (d < bd) { bd = d; best = b; }
      }
      if (best) this.angle = Math.atan2(best.y - c.y, best.x - c.x);
      this.fine = 0; this.ui.fine && this.ui.fine(0);
    }

    cuePos() {
      if (this.hand) return { x: this.hand.x, y: this.hand.y };
      const c = this.state.balls[0]; return { x: c.x, y: c.y };
    }
    aimDir() { const a = this.angle + rad(this.fine); return { dx: Math.cos(a), dy: Math.sin(a) }; }

    /* ---------- HUD 資料 ---------- */
    refresh() {
      const s = this.state, kind = s.kind, seats = [];
      if (this.statusState !== s) { this.statusState = s; this.statusRevision++; }
      for (let i = 0; i < 2; i++) {
        const o = { seat: i, name: this.seatName(i), you: i === this.mySeat, isTurn: s.turn === i && s.phase !== 'over', line1: '', line2: '', balls: [], pottedBalls: (this.stats[i] && this.stats[i].pottedBalls || []).slice(), score: null };
        if (kind === 'eight') {
          const g = s.groups[i];
          o.line1 = g ? (g === 'solid' ? '全色球 1~7' : '半色球 9~15') : '尚未分花色';
          if (g) {
            const ids = g === 'solid' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
            const left = ids.filter(id => Rules.getBall(s, id).pocket < 0).length;
            o.balls = ids.map(id => ({ id, out: Rules.getBall(s, id).pocket >= 0 })).concat([{ id: 8, out: Rules.getBall(s, 8).pocket >= 0, next: left === 0 }]);
            o.line2 = left === 0 ? '只剩 8 號球' : '剩 ' + left + ' 顆';
          }
        } else if (kind === 'score') {
          o.score = s.scores[i]; o.line1 = s.scores[i] + ' 分'; o.line2 = '先到 ' + s.target + ' 分獲勝';
        } else {
          const t = Rules.onTable(s).map(b => b.id), m = t.length ? Math.min.apply(null, t) : 0;
          o.line1 = '9 號球進袋者勝'; o.line2 = '最小的球：' + m + ' 號';
          o.balls = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id => ({ id, out: Rules.getBall(s, id).pocket >= 0, next: id === m }));
        }
        seats.push(o);
      }
      let status = '', hint = '';
      if (s.phase === 'over') status = '對局結束';
      else if (s.phase === 'choice') status = s.pending.player === this.mySeat ? '請做出選擇' : '等待 ' + this.seatName(s.pending.player) + ' 選擇';
      else if (this.mySeat < 0) status = '輪到 ' + this.seatName(s.turn) + ' 出桿';
      else if (this.phase === 'thinking') status = this.seatName(s.turn) + ' 思考中…';
      else if (s.turn === this.mySeat) status = '輪到你出桿' + this.targetText(s, s.turn, true);
      else status = '輪到 ' + this.seatName(s.turn) + ' 出桿';
      if (s.phase === 'play' && s.turn === this.mySeat) {
        if (s.hand) hint = s.hand.behindHead ? '拖曳母球到開球線後方，再瞄準' : '自由球：可以把母球拖到任何空位';
        if (Rules.needCallBall(s)) hint = this.safety ? '安全球：不計分、不扣分，輪到對手' : (this.callBall < 0 ? '先點要打的球，再點它要進的袋口（或按「安全球」）' : (this.call < 0 ? '再點這顆球要進的袋口' : '已叫球，可以擊球'));
        else if (Rules.needCall(s)) hint = this.call < 0 ? '請先點選 8 號球要進的袋口（金色虛線圈）' : '已指定袋口，可以擊球';
        if (!hint) hint = this.ruleLine(s);
      } else hint = this.ruleLine(s);
      if (s.last && s.last.fouls && s.last.fouls.length && s.phase !== 'over') hint = '上一桿：' + this.seatName(s.last.player) + ' 犯規（' + s.last.fouls.map(f => Rules.FOUL_TEXT[f]).join('、') + '）' + (s.hand && s.hand.player === this.mySeat ? '，你可以自由放置母球' : '');
      this.ui.hud && this.ui.hud({ kind, kindName: Rules.KIND_NAME[kind], seats, turn: s.turn, status, statusRevision: this.statusRevision, hint, phase: this.phase, over: s.phase === 'over', mode: this.cfg.mode, practice: this.cfg.mode === 'practice', potted: this.cfg.mode === 'practice' ? this.practiceCount || 0 : null });
      this.pushControls();
    }
    targetText(s, seat, withDot) {
      let t = '';
      if (s.kind === 'eight') {
        const g = s.groups[seat];
        if (!g) t = s.isBreak ? '開球' : '打任何一顆（8 號球除外）';
        else if (Rules.needCall(s) && seat === s.turn) t = '打 8 號球';
        else t = g === 'solid' ? '打全色球' : '打半色球';
      } else if (s.kind === 'nine') { const ids = Rules.legalFirstIds(s); t = s.isBreak ? '開球' : '先碰 ' + (ids[0] || '') + ' 號球'; }
      else t = s.isBreak ? '開球' : (s.kids ? '打進任何球就得 1 分' : '叫球：點球再點袋口');
      return withDot ? ' ・ ' + t : t;
    }
    ruleLine(s) {
      if (s.kind === 'nine') return '規則：先碰最小號的球，打進 9 號球就贏';
      if (s.kind === 'eight') return '規則：先清完自己的花色，再把 8 號球打進指定袋口';
      return s.kids ? '規則：每進一顆球得 1 分，先到 ' + s.target + ' 分獲勝' : '規則：叫球（點球＋點袋口）進袋得 1 分、犯規扣 1 分，先到 ' + s.target + ' 分獲勝';
    }
    pushControls() {
      const s = this.state, can = this.phase === 'aiming';
      let ok = can;
      if (can && s.hand && this.hand && !this.hand.ok) ok = false;
      if (can && Rules.needCall(s) && this.call < 0) ok = false;
      const cb = Rules.needCallBall(s);
      if (can && cb && !this.safety && (this.callBall < 0 || this.call < 0)) ok = false;
      this.ui.controls && this.ui.controls({ enabled: can, canShoot: ok, needCall: can && (Rules.needCall(s) || (cb && !this.safety)), safetyBtn: can && cb, safety: this.safety, spectator: this.mySeat < 0, thinking: this.phase === 'thinking', _x: 0, });
    }

    /* ---------- 輸入 ---------- */
    setPower(p) { this.power = Math.max(0.02, Math.min(1, p)); this.ui.power && this.ui.power(this.power); this.sendAim(); }
    setFine(d) { this.fine = Math.max(-4, Math.min(4, d)); this.ui.fine && this.ui.fine(this.fine); this.sendAim(); }
    setSpin(u, v) {
      const l = Math.hypot(u, v); if (l > 1) { u /= l; v /= l; }
      this.spin = { u, v }; if (this.jump && (u !== 0 || v !== 0)) this.jump = false; this.ui.spin && this.ui.spin(u, v);
    }
    /* 推桿／定桿／拉桿：一鍵設定擊球點（再按一次同一個＝回到正中央） */
    cueMode() {
      if (this.jump) return 'jump';
      const { u, v } = this.spin; if (Math.abs(u) > 0.02) return null;
      if (Math.abs(v - C.PRESET_FOLLOW) < 0.02) return 'follow';
      if (Math.abs(v - C.PRESET_STOP) < 0.015) return 'stop';
      if (Math.abs(v - C.PRESET_DRAW) < 0.02) return 'draw';
      return null;
    }
    setCueMode(mode) {
      if (this.phase !== 'aiming') return;
      if (this.cueMode() === mode) { this.jump = false; this.setSpin(0, 0); return; }
      if (mode === 'jump') { this.setSpin(0, 0); this.jump = true; this.ui.spin && this.ui.spin(0, 0); Sound.sfx.click && Sound.sfx.click(); return; }
      this.setSpin(0, mode === 'follow' ? C.PRESET_FOLLOW : (mode === 'draw' ? C.PRESET_DRAW : C.PRESET_STOP));
      Sound.sfx.click && Sound.sfx.click();
    }
    nudge(deg) { if (this.phase === 'aiming') { this.angle += rad(deg); this.sendAim(); } }
    selectPocket(i) {
      if (this.phase !== 'aiming') return;
      if (Rules.needCall(this.state)) { this.call = i; }
      else if (Rules.needCallBall(this.state)) { this.call = i; this.safety = false; }
      else return;
      Sound.sfx.click(); this.pushControls(); this.refresh();
    }
    selectBall(id) { if (this.phase === 'aiming' && Rules.needCallBall(this.state)) { this.callBall = id; this.safety = false; Sound.sfx.click(); this.pushControls(); this.refresh(); } }
    toggleSafety() { if (this.phase === 'aiming' && Rules.needCallBall(this.state)) { this.safety = !this.safety; Sound.sfx.click(); this.pushControls(); this.refresh(); } }
    ballHit(px, py) {
      const t = this.r.toTable(px, py); let best = -1, bd = C.R * 1.6;
      for (const b of this.state.balls) { if (b.id < 1 || b.pocket >= 0) continue; const d = Math.hypot(b.x - t.x, b.y - t.y); if (d < bd) { bd = d; best = b.id; } }
      return best;
    }

    _pt(e) { const r = this.canvas.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; }
    _bindPointer() {
      const cv = this.canvas;
      cv.style.touchAction = 'none';
      cv.addEventListener('pointerdown', e => {
        if (this.phase !== 'aiming') return;
        Sound.unlock();
        const { px, py } = this._pt(e), t = this.r.toTable(px, py);
        if (Rules.needCall(this.state) || Rules.needCallBall(this.state)) { const pk = this.r.pocketHit(px, py); if (pk >= 0) { this.selectPocket(pk); return; } }
        if (Rules.needCallBall(this.state)) { const id = this.ballHit(px, py); if (id > 0) { this.selectBall(id); return; } }
        const c = this.cuePos();
        if (this.hand && Math.hypot(t.x - c.x, t.y - c.y) < C.R * 3.2) {
          this.dragMode = 'hand'; this.dragOff = { x: c.x - t.x, y: c.y - t.y };
        } else { this.dragMode = 'aim'; this.lastPtAngle = Math.atan2(t.y - c.y, t.x - c.x); }
        cv.classList.remove('grab'); cv.classList.add(this.dragMode === 'hand' ? 'grabbing' : 'turning');
        cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      cv.addEventListener('pointermove', e => {
        if (!this.dragMode) {
          const q0 = this._pt(e), t0 = this.r.toTable(q0.px, q0.py), cp0 = this.cuePos();
          cv.classList.toggle('aimable', this.phase === 'aiming');
          cv.classList.toggle('grab', this.phase === 'aiming' && !!this.hand && Math.hypot(t0.x - cp0.x, t0.y - cp0.y) < C.R * 3.2);
        }
        if (!this.dragMode) {                              // 叫球：滑鼠移到可點的球或袋口時變成手指，不用十字
          let hot = false;
          if (this.phase === 'aiming' && (Rules.needCall(this.state) || Rules.needCallBall(this.state))) {
            const q = this._pt(e); hot = this.r.pocketHit(q.px, q.py) >= 0 || (Rules.needCallBall(this.state) && this.ballHit(q.px, q.py) > 0);
          }
          cv.classList.toggle('hot', hot);
        }
        if (!this.dragMode || this.phase !== 'aiming') return;
        const { px, py } = this._pt(e), t = this.r.toTable(px, py);
        if (this.dragMode === 'hand') {
          const x = t.x + this.dragOff.x, y = t.y + this.dragOff.y;
          this.hand.x = Math.max(C.R, Math.min(C.W - C.R, x)); this.hand.y = Math.max(C.R, Math.min(C.H - C.R, y));
          this.hand.ok = Rules.validCuePlacement(this.state, this.hand.x, this.hand.y);
          if (this.hand.ok) this.hand.last = { x: this.hand.x, y: this.hand.y };
          this.pushControls(); this.sendAim();
        } else {
          const c = this.cuePos(), a = Math.atan2(t.y - c.y, t.x - c.x), dist = Math.hypot(t.x - c.x, t.y - c.y);
          let d = a - this.lastPtAngle; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
          if (dist > 24) { this.angle += d * (dist < 70 ? 0.55 : 1); this.lastPtAngle = a; this.sendAim(); }
        }
        e.preventDefault();
      });
      const up = () => {
        if (this.dragMode === 'hand' && this.hand && !this.hand.ok) {
          const s = Rules.nearestValidCue(Object.assign({}, this.state, { hand: this.state.hand }), this.hand.x, this.hand.y);
          this.hand.x = s.x; this.hand.y = s.y; this.hand.ok = true; this.hand.last = { x: s.x, y: s.y };
          this.pushControls(); this.sendAim();
        }
        this.dragMode = null; cv.classList.remove('turning', 'grabbing');
      };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      cv.addEventListener('wheel', e => { if (this.phase === 'aiming') { this.setPower(this.power + (e.deltaY < 0 ? 0.03 : -0.03)); e.preventDefault(); } }, { passive: false });
    }
    handleKey(e) {
      if (this.phase !== 'aiming') return false;
      const fine = e.shiftKey ? 0.05 : 0.4;
      if (e.key === 'ArrowLeft') { this.nudge(-fine); return true; }
      if (e.key === 'ArrowRight') { this.nudge(fine); return true; }
      if (e.key === 'ArrowUp') { this.setPower(this.power + 0.02); return true; }
      if (e.key === 'ArrowDown') { this.setPower(this.power - 0.02); return true; }
      if (e.key === '1') { this.setCueMode('follow'); return true; }
      if (e.key === '2') { this.setCueMode('stop'); return true; }
      if (e.key === '3') { this.setCueMode('draw'); return true; }
      if (e.key === '4') { this.setCueMode('jump'); return true; }
      if (e.key === '0') { this.jump = false; this.setSpin(0, 0); return true; }
      if (e.key === ' ' || e.key === 'Enter') { this.shoot(); return true; }
      return false;
    }

    sendAim(force) {
      if (!this.isOnline || !this.cfg.net || this.phase !== 'aiming') return;
      const t = performance.now(); if (!force && t - this.lastAimSent < 90) return;
      this.lastAimSent = t;
      const d = this.aimDir(), m = { type: 'aim', x: d.dx, y: d.dy, p: this.power };
      if (this.hand) m.cue = { x: this.hand.x, y: this.hand.y };
      this.cfg.net.send(m);
    }

    /* ---------- 出桿 ---------- */
    buildShot() {
      const d = this.aimDir(), q = P.quantizeDir(d.dx, d.dy);
      const shot = { ax: q.ax, ay: q.ay, power: Math.max(8, Math.round(this.power * 1000)), sx: Math.round(this.spin.u * C.SPIN_MAX * 1000), sy: Math.round(-this.spin.v * C.SPIN_MAX * 1000) };
      if (this.jump) { shot.jump = 1; shot.sx = 0; shot.sy = 0; }
      if (this.hand) shot.cue = { x: Math.round(this.hand.x * 100) / 100, y: Math.round(this.hand.y * 100) / 100 };
      if (Rules.needCall(this.state)) shot.call = this.call;
      else if (Rules.needCallBall(this.state)) { if (this.safety) shot.safety = 1; else { shot.cb = this.callBall; shot.call = this.call; } }
      return shot;
    }
    shoot() {
      if (this.phase !== 'aiming') return false;
      if (this.hand && !this.hand.ok) { this.ui.toast && this.ui.toast('母球的位置不合法'); return false; }
      if (Rules.needCall(this.state) && this.call < 0) { this.ui.toast && this.ui.toast('請先點選 8 號球要進的袋口'); this.flashT = performance.now(); return false; }
      if (Rules.needCallBall(this.state) && !this.safety && (this.callBall < 0 || this.call < 0)) { this.ui.toast && this.ui.toast(this.callBall < 0 ? '請先點選要打的球，再點袋口（或按「安全球」）' : '請再點選這顆球要進的袋口'); this.flashT = performance.now(); return false; }
      const shot = this.buildShot();
      const err = Rules.validateShot(this.state, shot);
      if (err) { this.ui.toast && this.ui.toast(err); return false; }
      Sound.unlock();
      if (this.isOnline) { this.cfg.net.send({ type: 'shot', shot }); this.awaitEcho = true; }
      this.playShot(shot, this.mySeat);
      this.jump = false; this.setSpin(0, 0);    // 每桿都重新選：推桿/定桿/拉桿用完自動回到正中央
      return true;
    }

    playShot(shot, seat) {
      this.hand = null; this.remoteAim = null;
      this.curShot = { shot, seat };
      const s = this.state;
      this.world = Rules.prepareWorld(s, shot);
      this.world.recordEvents = true;
      const v = P.powerToSpeed(shot.power);
      const pull = 14 + (shot.power / 1000) * 62;
      this.anim = { t: 0, pull, dir: { dx: shot.ax / 1e6, dy: shot.ay / 1e6 }, back: 0.26 + (shot.power / 1000) * 0.12, fwd: 0.07, impacted: false, speed: v };
      this.phase = 'strike'; this.ui.controls && this.ui.controls({ enabled: false, canShoot: false });
      this.refreshStatusOnly();
    }
    refreshStatusOnly() { this.ui.hud && this.refresh(); }

    /* ---------- 主迴圈 ---------- */
    frame(now) {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
      this.update(dt, now);
      this.draw(now);
      this.raf = requestAnimationFrame(t => this.frame(t));
    }
    update(dt, now) {
      if (this.phase === 'strike') {
        const a = this.anim; a.t += dt;
        if (!a.impacted && a.t >= a.back + 0.05 + a.fwd) {
          a.impacted = true;
          P.applyShot(this.world, this.curShot.shot);
          Sound.sfx.strike(this.curShot.shot.power / 1000);
          this.phase = 'roll'; this.acc = 0;
        }
      } else if (this.phase === 'roll') {
        this.acc += dt;
        let n = 0;
        while (this.acc >= C.DT && n < 70) { P.stepWorld(this.world); this.acc -= C.DT; n++; if (P.isAtRest(this.world)) break; }
        this.drainEvents(now);
        if (P.isAtRest(this.world) || this.world.t > C.MAX_SIM_TIME) { this.drainEvents(now); this.phase = 'settle'; this.settleAt = now; }
      } else if (this.phase === 'settle') {
        if (!this.dropping.length || now - this.settleAt > 450) this.finalize();
      } else if (this.phase === 'thinking' && this.aiAnim) {
        const a = this.aiAnim, k = Math.min(1, (now - a.t0) / a.dur), e = k * k * (3 - 2 * k);
        this.angle = a.from + (a.to - a.from) * e;
        if (k >= 1 && !a.fired) { a.fired = true; this.fireAI(); }
      }
      // 進袋動畫
      if (this.dropping.length) this.dropping = this.dropping.filter(d => now - d.t0 < 320);
      // 倒數
      if (this.turnEnd && (this.phase === 'aiming' || this.phase === 'waiting' || this.phase === 'choice')) {
        const sec = Math.max(0, Math.ceil((this.turnEnd - now) / 1000));
        if (sec !== this.lastSec) { this.lastSec = sec; this.ui.timer && this.ui.timer(sec, this.isMyTurn || (this.phase === 'choice' && this.state.pending && this.state.pending.player === this.mySeat)); if (sec <= 5 && sec > 0 && this.isMyTurn) Sound.sfx.tick(); }
      } else if (this.lastSec !== -1 && !this.turnEnd) { this.lastSec = -1; this.ui.timer && this.ui.timer(null); }
      if (this.remoteAim && now - this.remoteAim.t > 4000) this.remoteAim = null;
    }
    drainEvents(now) {
      const w = this.world, ev = w.events;
      for (let i = 0; i < ev.length; i++) {
        const e = ev[i];
        if (e.type === 'hit') Sound.sfx.hit(e.speed);
        else if (e.type === 'land') Sound.sfx.hit(260);
        else if (e.type === 'rail') Sound.sfx.rail(e.speed);
        else if (e.type === 'pocket') {
          Sound.sfx.pocket();
          if (this.store.get('vibrate') && navigator.vibrate) { try { navigator.vibrate(22); } catch (x) { /* ignore */ } }
          this.dropping.push({ id: e.ball, x: e.x, y: e.y, pocket: e.pocket, t0: now });
        }
      }
      ev.length = 0;
    }

    draw(now) {
      const s = this.state; if (!s) return;
      let balls;
      if (this.world && (this.phase === 'roll' || this.phase === 'settle' || this.phase === 'strike')) balls = this.world.balls;
      else balls = s.balls;
      if (this.hand) {
        balls = balls.map(b => b.id === 0 ? { id: 0, x: this.hand.x, y: this.hand.y, pocket: -1 } : b);
      }
      const sc = { balls, dropping: this.dropping.map(d => ({ id: d.id, x: d.x, y: d.y, pocket: d.pocket, t: (now - d.t0) / 320 })) };
      const cue = balls.find(b => b.id === 0);
      const cueOk = cue && cue.pocket < 0;
      const aimMode = this.cfg.mode === 'online' ? this.cfg.aimMode : this.store.get('aim');
      if (cueOk && this.phase === 'aiming') {
        const d = this.aimDir(), cp = { x: cue.x, y: cue.y };
        sc.cue = { show: true, x: cp.x, y: cp.y, dx: d.dx, dy: d.dy, pull: 8 + this.power * 70, skin: this.mySkin(), off: this.spin.u * C.R * 0.7 };
        sc.cueDot = { u: this.spin.u, v: this.spin.v, dx: d.dx, dy: d.dy };
        if (aimMode !== 'off') {
          sc.aim = { lines: this.r.aimLines(balls, cp, d.dx, d.dy, aimMode, -this.spin.v, this.jump ? C.JUMP_MIN + C.JUMP_K * this.power : 0) };
          if (this.jump) {                                // 跳桿提示：直線上第一個碰到的球若本來就是合法目標，就不需要跳
            const st = this.r.aimLines(balls, cp, d.dx, d.dy, 'short', 0, 0), legal = Rules.legalFirstIds(s);
            sc.aim.lines.jumpUnneeded = !st.hitId || legal.indexOf(st.hitId) >= 0;
          }
        }
        if (this.hand) sc.hand = { x: this.hand.x, y: this.hand.y, ok: this.hand.ok };
        if (Rules.needCall(s)) sc.pocketCall = { selectable: true, selected: this.call, flash: this.flashT || 0 };
        else if (Rules.needCallBall(s) && !this.safety) {
          sc.pocketCall = { selectable: true, selected: this.call, flash: this.flashT || 0 };
          const cbb = this.callBall > 0 ? Rules.getBall(s, this.callBall) : null; if (cbb && cbb.pocket < 0) sc.callBall = { x: cbb.x, y: cbb.y };
        }
      } else if (cueOk && this.phase === 'thinking') {
        const d = { dx: Math.cos(this.angle), dy: Math.sin(this.angle) };
        sc.cue = { show: true, x: cue.x, y: cue.y, dx: d.dx, dy: d.dy, pull: 10 + 8 * Math.sin(now / 160), skin: this.skinFor(s.turn) };
      } else if (cueOk && this.phase === 'strike') {
        const a = this.anim, t = a.t; let pull;
        if (t < a.back) { const k = t / a.back; pull = 6 + (a.pull) * (k * k * (3 - 2 * k)); }
        else if (t < a.back + 0.05) pull = 6 + a.pull;
        else { const k = Math.min(1, (t - a.back - 0.05) / a.fwd); pull = 6 + a.pull * (1 - k * k) - 6 * k; }
        const cs = this.world.balls[0];
        sc.cue = { show: true, x: cs.x, y: cs.y, dx: a.dir.dx, dy: a.dir.dy, pull: pull, skin: this.skinFor(this.curShot.seat) };
      } else if (cueOk && this.phase === 'waiting' && this.remoteAim) {
        const ra = this.remoteAim, cp = ra.cue || { x: cue.x, y: cue.y };
        sc.cue = { show: true, x: cp.x, y: cp.y, dx: ra.dx, dy: ra.dy, pull: 8 + ra.p * 70, skin: this.skinFor(s.turn), alpha: 0.92 };
        if (ra.cue) { sc.balls = balls.map(b => b.id === 0 ? { id: 0, x: ra.cue.x, y: ra.cue.y, pocket: -1 } : b); }
      }
      if (this.phase === 'choice') sc.cue = null;
      if ((s.kind === 'eight' || s.kind === 'score') && this.phase !== 'aiming' && this.curShot && this.curShot.shot.call != null && (this.phase === 'roll' || this.phase === 'strike')) {
        sc.pocketCall = { selectable: false, selected: this.curShot.shot.call };
        if (this.curShot.shot.cb) { const cb2 = this.curShot.preBalls && this.curShot.preBalls.filter(b => b.id === this.curShot.shot.cb)[0]; const lb = this.world && this.world.balls.filter(b => b.id === this.curShot.shot.cb)[0]; const q = lb && lb.pocket < 0 ? lb : cb2; if (q) sc.callBall = { x: q.x, y: q.y }; }
      }
      this.r.draw(sc, now);
    }
    skinFor(seat) {
      if (this.cfg.mode === 'online') return (this.cfg.cues && this.cfg.cues[seat]) || 'maple';
      return seat === this.mySeat ? this.store.get('cue') : (this.cfg.mode === 'ai' ? 'ebony' : this.store.get('cue'));
    }
    mySkin() { return this.store.get('cue'); }

    /* ---------- 一桿結束 ---------- */
    finalize() {
      const shot = this.curShot.shot, seat = this.curShot.seat;
      const res = P.collect(this.world);
      const before = this.state;
      this.world = null; this.anim = null; this.dropping = [];
      let info;
      try { info = Rules.evaluateShot(before, shot, res); } catch (e) { console.error(e); return; }
      if (this.cfg.mode === 'practice') info = this.practiceFix(info);
      let finalState = info.state, provisional = false;
      if (this.isOnline) {
        const ps = this.pendingSettle;
        if (ps && ps.shotNo === before.shotNo + 1) {
          if (ps.hash && ps.hash !== res.hash) console.warn('[sync] 本地結果與伺服器不同，改用伺服器：', ps.hash, res.hash);
          finalState = ps.state; info = Object.assign({}, info, ps.info || {}); this.pendingSettle = null;
          if (ps.turnMs != null) this.turnEnd = ps.turnMs ? performance.now() + ps.turnMs : 0;
        } else provisional = true;
      }
      this.curShot = null; this.awaitEcho = false;
      this.provisional = provisional; this.provisionalShotNo = before.shotNo + 1;
      this.afterResult(before, finalState, info, seat);
    }
    afterResult(before, after, info, seat) {
      const st = this.stats[seat];
      if (st) {
        const pocketed = info.pocketedObjects || [];
        st.shots++; st.potted += pocketed.length; st.pottedBalls.push.apply(st.pottedBalls, pocketed);
        const foul = info.fouls && info.fouls.length > 0;
        if (foul) st.fouls++;
        if (info.continued) { st.run += pocketed.length; } else { st.run = pocketed.length; }
        st.best = Math.max(st.best, st.run);
      }
      this.state = after;
      // 提示
      const name = this.seatName(seat);
      const parts = [];
      if (info.fouls && info.fouls.length) { Sound.sfx.foul(); if (this.store.get('vibrate') && navigator.vibrate) { try { navigator.vibrate([40, 40, 60]); } catch (e) { /* ignore */ } } parts.push('犯規：' + info.fouls.map(f => Rules.FOUL_TEXT[f]).join('、')); }
      if (after.kind === 'score') {
        if (info.penalty) parts[parts.length - 1] += '，扣 1 分';
        if (info.safety) parts.push(name + ' 打安全球');
        else if (info.made) parts.push(name + ' 進袋 +' + info.pts + ' 分');
        else if (info.missedCall) parts.push(name + ' 沒叫中');
        if (info.reracked) parts.push('14 顆重新排球');
      } else if (info.pocketedObjects && info.pocketedObjects.length) parts.push(name + ' 進袋 ' + info.pocketedObjects.join('、') + ' 號');
      (info.notes || []).forEach(n => { if (n.code === 'assign') parts.push(this.seatName(n.player) + ' 打' + (n.group === 'solid' ? '全色球' : '半色球')); });
      if (!parts.length && after.phase !== 'over') parts.push(name + ' 沒有進球');
      this.beginTurn();
      this.ui.toast && this.ui.toast(parts.join('，'), info.fouls && info.fouls.length ? 'foul' : 'info');
      this.drainQueue();
    }
    practiceFix(info) {
      const s = info.state; this.practiceCount = (this.practiceCount || 0) + (info.pocketedObjects || []).length;
      s.turn = 0; s.winner = null; s.phase = 'play'; s.reason = '';
      if (info.scratch) { s.hand = { player: 0, behindHead: false }; }
      else s.hand = null;
      if (Rules.onTable(s).length === 0) {
        const n = Rules.newGame(s.kind, { kids: true, bigPockets: s.bigPockets }, this.rng); n.shotNo = s.shotNo;
        info.state = n; this.ui.toast && this.ui.toast('清檯了！重新擺球');
      }
      return info;
    }

    /* ---------- 單機：電腦 ---------- */
    scheduleAI() {
      const s = this.state;
      this.after(60, () => {
        if (this.state !== s || this.phase !== 'thinking') return;
        const pick = AI.chooseShot(s, this.cfg.level, this.rng);
        this.aiPick = pick;
        const d = { x: pick.shot.ax / 1e6, y: pick.shot.ay / 1e6 };
        let to = Math.atan2(d.y, d.x), from = this.angle;
        while (to - from > Math.PI) to -= 2 * Math.PI; while (to - from < -Math.PI) to += 2 * Math.PI;
        this.aiAnim = { from, to, t0: performance.now(), dur: Math.max(700, pick.think), fired: false };
        // 電腦要自由球：先把母球放過去
        if (s.hand && pick.shot.cue) { this.state = Object.assign({}, s, { balls: s.balls.map(b => b.id === 0 ? Object.assign({}, b, { x: pick.shot.cue.x, y: pick.shot.cue.y }) : b) }); this._aiState = this.state; }
      });
    }
    fireAI() {
      const pick = this.aiPick; this.aiAnim = null; if (!pick) return;
      this.playShot(pick.shot, this.state.turn);
    }

    /* ---------- 八號球的選擇 ---------- */
    handleChoice() {
      const s = this.state, p = s.pending;
      if (this.cfg.mode === 'ai' || this.cfg.mode === 'practice') {
        if (p.player === this.mySeat) { this.showChoice(); return; }
        this.after(900, () => { if (this.state === s) this.applyChoice(p.type === 'break-fail' ? 'accept' : (p.type === 'eight-break' ? 'respot' : 'respot')); });
        return;
      }
      if (p.player === this.mySeat) this.showChoice(); else this.ui.choice && this.ui.choice(null);
    }
    showChoice() {
      const p = this.state.pending, opp = this.seatName(1 - p.player);
      const T = {
        'break-fail': { title: '開球沒有達標', desc: '開球時沒有球進袋，也沒有 4 顆球碰庫。你要怎麼處理？', options: [['accept', '接受現況', '你取得自由球，母球可以放在任何位置'], ['rerack', '要求重擺重開', '球重新擺好，由 ' + opp + ' 重新開球']] },
        'eight-break': { title: '開球時 8 號球進袋了', desc: '你可以選擇重開，或把 8 號球放回置球點繼續打。', options: [['rerack', '重擺重開', '球重新擺好，你再開一次球'], ['respot', '8 號球放回，繼續打', '8 號球放回置球點，你繼續出桿']] },
        'eight-break-scratch': { title: '開球時 8 號球與母球一起進袋', desc: opp + ' 開球時 8 號球與母球同時進袋。你可以選擇重開，或把 8 號球放回並取得自由球。', options: [['rerack', '重擺重開', '球重新擺好，由 ' + opp + ' 重新開球'], ['respot', '8 號球放回，我拿自由球', '8 號球放回置球點，你取得自由球']] }
      }[p.type];
      this.ui.choice && this.ui.choice({ title: T.title, desc: T.desc, options: T.options, seconds: this.turnEnd ? Math.max(0, Math.ceil((this.turnEnd - performance.now()) / 1000)) : null, onPick: c => this.applyChoice(c) });
    }
    applyChoice(c) {
      const s = this.state;
      if (s.phase !== 'choice') return;
      this.ui.choice && this.ui.choice(null);
      if (this.isOnline) { this.cfg.net.send({ type: 'choice', choice: c }); return; }
      const r = Rules.resolveChoice(s, c, this.rng);
      if (r.error) return;
      this.state = r.state;
      this.r.resetRolls();
      this.beginTurn();
      this.ui.toast && this.ui.toast(c === 'rerack' ? '重擺重開' : (c === 'respot' ? '8 號球放回置球點' : '接受現況'));
    }

    /* ---------- 結算 ---------- */
    showResult() {
      const s = this.state, w = s.winner;
      let reason = REASON[s.reason] || '', detail = '';
      if (s.reason === 'eight-foul') {
        reason = '8 號球判負：' + (EIGHT_LOSS[(s.last && s.last.eightLoss) || ''] || '8 號球不合法進袋');
      }
      if (s.last && s.last.eightLoss) reason = '8 號球判負：' + EIGHT_LOSS[s.last.eightLoss];
      if (s.reason === 'score') reason = '先拿到 ' + s.target + ' 分';
      if (s.reason === 'eight') reason = '8 號球打進指定袋口';
      const win = w >= 0 ? w : -1;
      const youWin = win === this.mySeat;
      if (win >= 0) { (this.mySeat >= 0 ? (youWin ? Sound.sfx.win() : Sound.sfx.lose()) : Sound.sfx.win()); }
      if (this.mySeat >= 0 && this.cfg.mode !== 'practice' && !this._recorded) {
        this._recorded = true;
        this.store.addStats({ games: 1, wins: youWin ? 1 : 0, losses: win >= 0 && !youWin ? 1 : 0, draws: win < 0 ? 1 : 0, potted: this.stats[this.mySeat].potted, bestRun: this.stats[this.mySeat].best });
      }
      this.ui.result && this.ui.result({
        winner: win, youWin, spectator: this.mySeat < 0, reason, kind: s.kind, kindName: Rules.KIND_NAME[s.kind],
        names: [this.seatName(0), this.seatName(1)], stats: this.stats, shots: s.shotNo, scores: s.scores, mode: this.cfg.mode, draw: win < 0
      });
    }
    nextGame() {
      this._recorded = false;
      this.stats = [0, 1].map(() => ({ shots: 0, potted: 0, pottedBalls: [], fouls: 0, run: 0, best: 0 }));
      this.state = Rules.nextGame(this.state, this.rng);
      if (this.cfg.mode === 'ai') { /* 開球權互換：玩家第二局由電腦開球 */ }
      this.r.resetRolls(); this.ui.result && this.ui.result(null);
      this.beginTurn(true);
    }
    resetPractice() {
      this.practiceCount = 0;
      this.state = Rules.newGame(this.state.kind, { kids: true, bigPockets: this.state.bigPockets }, this.rng);
      this.r.resetRolls(); this.beginTurn(true);
    }

    /* ---------- 線上訊息 ---------- */
    busy() { return this.phase === 'strike' || this.phase === 'roll' || this.phase === 'settle'; }
    onNet(m) {
      if (!this.isOnline) return;
      if (m.type === 'aim') {
        if (this.phase === 'waiting' && m.seat === this.state.turn) this.remoteAim = { dx: m.x, dy: m.y, p: m.p, cue: m.cue, t: performance.now() };
        return;
      }
      if (m.type === 'shot') {
        if (m.seat === this.mySeat && (this.awaitEcho || this.busy())) { this.awaitEcho = false; return; }   // 自己的出桿已經先播了
        if (this.busy()) { this.queue.push(m); return; }
        if (m.shotNo !== this.state.shotNo + 1) { this.cfg.net.send({ type: 'sync' }); this.queue.push(m); return; }
        this.pendingSettle = null; this.playShot(m.shot, m.seat); return;
      }
      if (m.type === 'settle') {
        if (this.busy() || (this.curShot)) { this.pendingSettle = m; return; }
        if (this.provisional && m.shotNo === this.provisionalShotNo) {
          const same = JSON.stringify(m.state) === JSON.stringify(this.state);
          this.provisional = false;
          if (!same) { const turnChanged = m.state.turn !== this.state.turn || m.state.phase !== this.state.phase; this.state = m.state; if (turnChanged) this.beginTurn(); else this.refresh(); }
          if (m.turnMs != null) this.turnEnd = m.turnMs ? performance.now() + m.turnMs : 0;
          return;
        }
        if (m.shotNo > this.state.shotNo) { this.state = m.state; this.beginTurn(); }
        return;
      }
      if (m.type === 'state') {
        if (this.busy()) { this.queue.push(m); return; }
        this.applyStateMsg(m); return;
      }
      if (m.type === 'game') { this.applyFullSync(m.game); return; }
    }
    applyStateMsg(m) {
      const before = this.state;
      let notice = null, noticeKind = 'message';
      this.state = m.state; this.provisional = false;
      if (m.turnMs != null) this.turnEnd = m.turnMs ? performance.now() + m.turnMs : 0;
      if (m.info && m.info.fouls && m.info.fouls.includes('timeout')) { Sound.sfx.foul(); notice = this.seatName(m.info.player) + ' 回合超時，換對手出桿，並取得自由球'; noticeKind = 'foul'; }
      if (m.choice) {
        this.r.resetRolls();
        const t = m.choice.choice === 'rerack' ? '重擺重開' : (m.choice.choice === 'respot' ? '8 號球放回置球點' : '接受現況');
        notice = this.seatName(m.choice.player) + ' 選擇：' + t + (m.choice.by === 'timeout' ? '（時間到，自動選擇）' : '');
      }
      this.beginTurn();
      if (notice) this.ui.toast && this.ui.toast(notice, noticeKind);
    }
    drainQueue() {
      if (!this.queue.length || this.busy()) return;
      const q = this.queue.slice(); this.queue = [];
      for (const m of q) this.onNet(m);
    }
    applyFullSync(game) {
      this.clearTimers(); this.world = null; this.curShot = null; this.anim = null; this.dropping = []; this.awaitEcho = false; this.pendingSettle = null; this.provisional = false;
      if (game.cfg) { this.cfg.aimMode = game.cfg.aim; }
      this.cfg.seats = game.seats.map(s => ({ name: s.name })); this.cfg.cues = game.seats.map(s => s.cue);
      this.state = game.state;
      this.turnEnd = game.turnMs ? performance.now() + game.turnMs : 0;
      this.r.resetRolls();
      this.beginTurn(true);
    }
    setSeatNames(seats) { this.cfg.seats = seats; if (this.state) this.refresh(); }
  }

  root.PoolGame = Game;
})(typeof self !== 'undefined' ? self : this);
