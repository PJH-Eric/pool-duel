/* 連線層：喚醒（Render 免費層會休眠）→ WebSocket → 心跳／測速 → 斷線自動重連。
   身分用 sessionStorage 裡的 clientId 認人，所以同一個分頁斷線後重連會回到原本的席位。 */
(function (root) {
  'use strict';
  const handlers = {};
  const Net = {
    status: 'idle', ws: null, personId: null, name: '', reconnectMs: 30000, wantOn: false,
    lastMsgAt: 0, retry: 0, pingTimer: null, watchTimer: null, rtt: null, welcomed: false,
    get enabled() { return !!(root.Config && root.Config.status === 'ok' && root.Config.serverUrl); },
    get wsUrl() { return root.Config.serverUrl.replace(/^http/i, 'ws') + '/ws'; },
    on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    emit(type, a) { (handlers[type] || []).slice().forEach(f => { try { f(a); } catch (e) { console.error(e); } }); },
    setStatus(s, text) { this.status = s; this.emit('status', { status: s, text: text || '' }); },
    send(o) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; } return false; },

    connect(name) {
      if (!this.enabled) { this.setStatus('disabled', '目前沒有設定伺服器，只能玩單機'); return; }
      if (name != null) this.name = name;
      this.wantOn = true;
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      this.wake();
    },
    async wake() {
      this.setStatus('waking', '連線中…（伺服器休眠時，第一次要等 30～60 秒）');
      const t0 = Date.now();
      while (this.wantOn) {
        try {
          const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 6000);
          const r = await fetch(root.Config.serverUrl + '/health', { signal: ctl.signal, cache: 'no-store' }); clearTimeout(to);
          if (r.ok) break;
        } catch (e) { /* 還沒醒 */ }
        if (Date.now() - t0 > 100000) { this.setStatus('failed', '連不上伺服器。請確認網路，或稍後再試'); this.wantOn = false; return; }
        await new Promise(r => setTimeout(r, 2200));
        this.setStatus('waking', '伺服器喚醒中…已等 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
      }
      if (!this.wantOn) return;
      this.open();
    },
    open() {
      this.setStatus('connecting', '正在連線…');
      let ws;
      try { ws = new WebSocket(this.wsUrl); } catch (e) { this.scheduleRetry(); return; }
      this.ws = ws; this.welcomed = false;
      ws.onopen = () => {
        this.lastMsgAt = Date.now();
        this.send({ type: 'hello', name: this.name, clientId: root.Store.clientId(), cue: root.Store.get('cue') });
        this.startTimers();
      };
      ws.onmessage = ev => {
        this.lastMsgAt = Date.now();
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'hb') { this.send({ type: 'hb' }); return; }
        if (m.type === 'pong') { this.rtt = Date.now() - m.t; root.Latency.set(this.rtt); this.emit('rtt', this.rtt); return; }
        if (m.type === 'welcome') { this.personId = m.personId; this.name = m.name; this.reconnectMs = m.reconnectMs || 30000; this.welcomed = true; this.retry = 0; this.setStatus('open', ''); }
        this.emit('msg', m); this.emit(m.type, m);
      };
      ws.onclose = () => { if (this.ws !== ws) return; this.ws = null; this.stopTimers(); root.Latency.set(null); this.emit('dropped'); if (this.wantOn) this.scheduleRetry(); else { this.setStatus('closed', ''); root.Latency.off(); } };
      ws.onerror = () => { /* onclose 會接手 */ };
    },
    scheduleRetry() {
      this.retry++;
      this.setStatus('retrying', '連線中斷，重新連線中…（第 ' + this.retry + ' 次）');
      setTimeout(() => { if (this.wantOn && !this.ws) this.open(); }, Math.min(4000, 700 + this.retry * 600));
    },
    startTimers() {
      this.stopTimers();
      this.pingTimer = setInterval(() => this.send({ type: 'ping', t: Date.now() }), 2500);
      this.watchTimer = setInterval(() => { if (this.ws && Date.now() - this.lastMsgAt > 9000) { try { this.ws.close(); } catch (e) { /* ignore */ } } }, 2000);
      this.send({ type: 'ping', t: Date.now() });
    },
    stopTimers() { clearInterval(this.pingTimer); clearInterval(this.watchTimer); this.pingTimer = this.watchTimer = null; },
    close() { this.wantOn = false; this.stopTimers(); if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } } this.ws = null; this.setStatus('closed', ''); root.Latency.off(); }
  };
  root.Net = Net;
})(typeof self !== 'undefined' ? self : this);
