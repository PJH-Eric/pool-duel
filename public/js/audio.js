/* 音效與背景音樂：全部用 WebAudio 即時合成，沒有任何外部音檔（授權乾淨、檔案小）。
   BGM：輕爵士酒吧（搖擺節奏、走動貝斯、鋼琴伴奏、刷子鈸、偶爾的旋律）。 */
(function (root) {
  'use strict';
  let ctx = null, master = null, sfxBus = null, musicBus = null, noiseBuf = null;
  let sfxOn = true, musicOn = true, sfxVol = 0.8, musicVol = 0.5;
  let timer = null, nextBarTime = 0, bar = 0, playing = false;

  function ensure() {
    if (ctx) return ctx;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
      sfxBus = ctx.createGain(); sfxBus.connect(master);
      musicBus = ctx.createGain(); musicBus.connect(master);
      // 簡單的小空間殘響（音樂用）
      const conv = ctx.createConvolver();
      const len = Math.floor(ctx.sampleRate * 1.2), buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
      conv.buffer = buf;
      const wet = ctx.createGain(); wet.gain.value = 0.28;
      musicBus.connect(conv); conv.connect(wet); wet.connect(master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      applyVol();
    } catch (e) { ctx = null; }
    return ctx;
  }
  function applyVol() {
    if (!ctx) return;
    sfxBus.gain.value = sfxOn ? sfxVol : 0;
    musicBus.gain.value = musicOn ? musicVol * 0.55 : 0;
  }
  function unlock() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (musicOn && !playing) startMusic();
  }
  function setVolumes(o) {
    if (o.sfxOn != null) sfxOn = !!o.sfxOn;
    if (o.musicOn != null) musicOn = !!o.musicOn;
    if (o.sfxVol != null) sfxVol = o.sfxVol;
    if (o.musicVol != null) musicVol = o.musicVol;
    applyVol();
    if (ctx) { if (musicOn && !playing && ctx.state === 'running') startMusic(); if (!musicOn && playing) stopMusic(); }
  }

  function env(g, t, a, peak, d) { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
  function noise(t, dur, freq, type, peak, q) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
    const g = ctx.createGain(); env(g, t, 0.002, peak, dur);
    s.connect(f); f.connect(g); g.connect(sfxBus); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }
  function tone(bus, t, f0, f1, dur, type, peak, a) {
    const o = ctx.createOscillator(); o.type = type || 'sine'; o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain(); env(g, t, a || 0.003, peak, dur);
    o.connect(g); g.connect(bus || sfxBus); o.start(t); o.stop(t + dur + (a || 0.003) + 0.05);
  }

  const lastAt = {};
  function throttle(key, ms) { const n = Date.now(); if (lastAt[key] && n - lastAt[key] < ms) return false; lastAt[key] = n; return true; }

  const sfx = {
    hit(speed) {
      if (!ensure() || !sfxOn || !throttle('hit', 25)) return;
      const t = ctx.currentTime, v = Math.min(1, speed / 1800), lvl = v > 0.55 ? 2 : (v > 0.2 ? 1 : 0);
      const f = [1500, 2100, 2800][lvl] + Math.random() * 200;
      tone(sfxBus, t, f, f * 0.7, 0.05 + lvl * 0.02, 'sine', 0.18 + v * 0.5);
      noise(t, 0.03, 4200, 'highpass', 0.12 + v * 0.35, 0.7);
    },
    strike(power) {
      if (!ensure() || !sfxOn) return;
      const t = ctx.currentTime, p = Math.min(1, power);
      tone(sfxBus, t, 380, 150, 0.09, 'sine', 0.25 + p * 0.35);
      noise(t, 0.04, 2500, 'bandpass', 0.2 + p * 0.3, 1.2);
    },
    rail(speed) {
      if (!ensure() || !sfxOn || !throttle('rail', 40)) return;
      const t = ctx.currentTime, v = Math.min(1, speed / 1500);
      tone(sfxBus, t, 130, 70, 0.12, 'sine', 0.12 + v * 0.4);
      noise(t, 0.07, 700, 'lowpass', 0.1 + v * 0.25, 0.8);
    },
    pocket() {
      if (!ensure() || !sfxOn) return;
      const t = ctx.currentTime;
      tone(sfxBus, t, 520, 140, 0.16, 'triangle', 0.3);
      for (let i = 0; i < 4; i++) { tone(sfxBus, t + 0.12 + i * 0.07 * (1 + i * 0.3), 260 - i * 30, 200 - i * 30, 0.05, 'sine', 0.18 - i * 0.03); }
      noise(t + 0.02, 0.25, 500, 'lowpass', 0.14, 0.7);
    },
    foul() {
      if (!ensure() || !sfxOn) return;
      const t = ctx.currentTime;
      tone(sfxBus, t, 260, 200, 0.18, 'sawtooth', 0.12); tone(sfxBus, t + 0.18, 200, 140, 0.26, 'sawtooth', 0.12);
    },
    win() {
      if (!ensure() || !sfxOn) return;
      const t = ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => { tone(sfxBus, t + i * 0.11, f, f, 0.5, 'triangle', 0.25); tone(sfxBus, t + i * 0.11, f * 2, f * 2, 0.4, 'sine', 0.08); });
    },
    lose() {
      if (!ensure() || !sfxOn) return;
      const t = ctx.currentTime;
      [392, 329.63, 261.63].forEach((f, i) => tone(sfxBus, t + i * 0.2, f, f * 0.98, 0.5, 'triangle', 0.2));
    },
    click() { if (!ensure() || !sfxOn || !throttle('click', 40)) return; const t = ctx.currentTime; tone(sfxBus, t, 900, 700, 0.05, 'sine', 0.18); },
    turn() { if (!ensure() || !sfxOn) return; const t = ctx.currentTime; tone(sfxBus, t, 880, 880, 0.2, 'sine', 0.2); tone(sfxBus, t + 0.12, 1320, 1320, 0.3, 'sine', 0.16); },
    tick() { if (!ensure() || !sfxOn || !throttle('tick', 300)) return; const t = ctx.currentTime; tone(sfxBus, t, 1200, 1200, 0.04, 'square', 0.06); },
    chat() { if (!ensure() || !sfxOn || !throttle('chat', 200)) return; const t = ctx.currentTime; tone(sfxBus, t, 660, 880, 0.08, 'sine', 0.14); }
  };

  /* ---------- 輕爵士 BGM ---------- */
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const BPM = 92, BEAT = 60 / BPM;
  const PROG = [
    { bass: [38, 41, 45, 48], comp: [53, 57, 60, 64], tones: [62, 65, 69, 72, 74] },   // Dm7
    { bass: [43, 47, 50, 53], comp: [53, 59, 62, 65], tones: [62, 67, 71, 74, 77] },   // G7
    { bass: [48, 52, 55, 47], comp: [52, 59, 62, 67], tones: [64, 67, 71, 72, 76] },   // Cmaj7
    { bass: [45, 48, 52, 55], comp: [55, 60, 64, 67], tones: [64, 67, 69, 72, 76] },   // Am7
    { bass: [38, 41, 45, 48], comp: [53, 57, 60, 64], tones: [62, 65, 69, 72, 74] },   // Dm7
    { bass: [43, 47, 50, 53], comp: [53, 59, 62, 65], tones: [62, 67, 71, 74, 77] },   // G7
    { bass: [40, 43, 47, 50], comp: [50, 55, 59, 62], tones: [64, 67, 71, 74, 76] },   // Em7
    { bass: [45, 49, 52, 55], comp: [55, 61, 64, 67], tones: [64, 69, 73, 76, 79] }    // A7
  ];
  function note(t, m, dur, type, peak, bus, a) { tone(bus || musicBus, t, mtof(m), mtof(m), dur, type || 'sine', peak, a || 0.01); }
  function ride(t, peak) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6500;
    const g = ctx.createGain(); env(g, t, 0.002, peak, 0.12);
    s.connect(f); f.connect(g); g.connect(musicBus); s.start(t, Math.random()); s.stop(t + 0.2);
  }
  function scheduleBar(t0, b) {
    const ch = PROG[b % PROG.length], sw = BEAT * 0.667;
    for (let i = 0; i < 4; i++) {
      // 走動貝斯
      note(t0 + i * BEAT, ch.bass[i], BEAT * 0.9, 'triangle', 0.5, musicBus, 0.015);
      // 刷子鈸：搖擺
      ride(t0 + i * BEAT, i % 2 === 1 ? 0.055 : 0.04);
      if (i % 2 === 1) ride(t0 + i * BEAT + sw, 0.03);
    }
    // 鋼琴伴奏（第 2 拍與第 3 拍的後半拍）
    [[1, 0], [2, sw]].forEach(([beat, off]) => {
      if (Math.random() < 0.85) ch.comp.forEach((m, k) => note(t0 + beat * BEAT + off + k * 0.012, m, BEAT * 0.8, 'sine', 0.11, musicBus, 0.006));
    });
    // 偶爾的旋律
    if (Math.random() < 0.7) {
      let beat = Math.floor(Math.random() * 2);
      const n = 2 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n && beat < 4; k++) {
        const m = ch.tones[Math.floor(Math.random() * ch.tones.length)];
        const off = Math.random() < 0.5 ? 0 : sw;
        note(t0 + beat * BEAT + off, m, BEAT * (Math.random() < 0.4 ? 1.4 : 0.7), 'triangle', 0.17, musicBus, 0.02);
        beat += 1 + Math.floor(Math.random() * 1.6);
      }
    }
  }
  function pump() {
    if (!ctx || !playing) return;
    while (nextBarTime < ctx.currentTime + 0.8) {
      scheduleBar(Math.max(nextBarTime, ctx.currentTime + 0.05), bar++);
      nextBarTime += BEAT * 4;
    }
  }
  function startMusic() {
    if (!ensure() || playing) return;
    playing = true; nextBarTime = ctx.currentTime + 0.1; bar = 0;
    pump(); timer = setInterval(pump, 250);
  }
  function stopMusic() { playing = false; if (timer) clearInterval(timer); timer = null; }

  root.Sound = { unlock, setVolumes, sfx, startMusic, stopMusic, ensure, get supported() { return !!(root.AudioContext || root.webkitAudioContext); } };
})(typeof self !== 'undefined' ? self : this);
