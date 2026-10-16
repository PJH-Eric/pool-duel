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
    /* key／params 是字典 key；text 是目前語言的字串（給只要文字的人） */
    setStatus(s, key, params) { this.status = s; this.emit('status', { status: s, key: key || '', params: params || null, text: key ? root.I18N.t(key, params) : '' }); },
    send(o) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; } return false; },

    connect(name) {
      if (!this.enabled) { this.setStatus('disabled', 'net.disabled'); return; }
      if (name != null) this.name = name;
      this.wantOn = true;
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      this.wake();
    },
    async wake() {
      this.setStatus('waking', 'net.waking');
      const t0 = Date.now();
      while (this.wantOn) {
        try {
          const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 6000);
          const r = await fetch(root.Config.serverUrl + '/health', { signal: ctl.signal, cache: 'no-store' }); clearTimeout(to);
          if (r.ok) break;
        } catch (e) { /* 還沒醒 */ }
        if (Date.now() - t0 > 100000) { this.setStatus('failed', 'net.failed'); this.wantOn = false; return; }
        await new Promise(r => setTimeout(r, 2200));
        this.setStatus('waking', 'net.wakingWait', { n: Math.round((Date.now() - t0) / 1000) });
      }
      if (!this.wantOn) return;
      this.open();
    },
    open() {
      this.setStatus('connecting', 'net.connecting');
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
      this.setStatus('retrying', 'net.retrying', { n: this.retry });
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
