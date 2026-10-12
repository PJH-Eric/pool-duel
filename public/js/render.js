/* 畫面繪製：寫實質感的桌面（胡桃木框、綠色桌布、黃銅與皮革袋口）、
   會依滾動方向轉動的球（逐像素的球面著色，數字與花紋跟著轉）、球桿、瞄準線。
   直向時整張桌子旋轉 90°（長邊直放），球的光影與數字方向仍保持「由上往下看」。 */
(function (root, factory) {
  const api = factory(root.PoolConfig, root.PoolPhysics, root.PoolThemes);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PoolRender = api;
})(typeof self !== 'undefined' ? self : this, function (C, P, Themes) {
  'use strict';
  if (!C && typeof require === 'function') { C = require('./physics-config.js'); P = require('./physics.js'); Themes = require('./themes/tables.js'); }
  const W = C.W, H = C.H, R = C.R;
  const FR = 66;                  // 木框寬（桌面單位）
  const CUSH = 30;                // 庫邊橡膠厚度
  const TWO_PI = Math.PI * 2;

  function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  /* ---------- 瞄準線（用幾何算：球心射線對球與庫邊） ---------- */
  function aimLines(balls, cue, dx, dy, mode, ts, jumpDist) {
    ts = ts || 0;
    if (jumpDist > 0 && mode !== 'off') {            // 跳桿：先飛到落點，再從落點往後算一般的瞄準線
      let tw0 = 1e9;
      if (dx > 1e-9) tw0 = Math.min(tw0, (W - R - cue.x) / dx); else if (dx < -1e-9) tw0 = Math.min(tw0, (R - cue.x) / dx);
      if (dy > 1e-9) tw0 = Math.min(tw0, (H - R - cue.y) / dy); else if (dy < -1e-9) tw0 = Math.min(tw0, (R - cue.y) / dy);
      const jd = Math.max(0, Math.min(jumpDist, tw0 - 1)), land = { x: cue.x + dx * jd, y: cue.y + dy * jd };
      const rest = aimLines(balls, land, dx, dy, mode, 0, 0);
      rest.jump = { from: { x: cue.x, y: cue.y }, to: land };
      return rest;
    }
    const out = { ghost: null, path: [], target: null, deflect: null, bounce: null };
    if (mode === 'off') return out;
    let best = 1e9, hit = null;
    for (const b of balls) {
      if (b.id === 0 || b.pocket >= 0) continue;
      const fx = cue.x - b.x, fy = cue.y - b.y;
      const bb = fx * dx + fy * dy, cc = fx * fx + fy * fy - 4 * R * R, disc = bb * bb - cc;
      if (disc < 0) continue;
      const t = -bb - Math.sqrt(disc);
      if (t > 0 && t < best) { best = t; hit = b; }
    }
    let tw = 1e9, wall = '';
    if (dx > 1e-9) { const t = (W - R - cue.x) / dx; if (t < tw) { tw = t; wall = 'x'; } } else if (dx < -1e-9) { const t = (R - cue.x) / dx; if (t < tw) { tw = t; wall = 'x'; } }
    if (dy > 1e-9) { const t = (H - R - cue.y) / dy; if (t < tw) { tw = t; wall = 'y'; } } else if (dy < -1e-9) { const t = (R - cue.y) / dy; if (t < tw) { tw = t; wall = 'y'; } }
    if (hit && best < tw) {
      const gx = cue.x + dx * best, gy = cue.y + dy * best;
      out.ghost = { x: gx, y: gy };
      out.path = [{ x: cue.x, y: cue.y }, { x: gx, y: gy }];
      const nx = (hit.x - gx) / (2 * R), ny = (hit.y - gy) / (2 * R);
      const L = mode === 'short' ? 70 : 170;
      out.target = [{ x: hit.x, y: hit.y }, { x: hit.x + nx * L, y: hit.y + ny * L }];
      if (mode !== 'short') {
        // 預測碰球後母球的走向（含推桿／定桿／拉桿）：v' = d·(1 + ts·K·vn) − (1+E)/2·vn·n
        const vn = dx * nx + dy * ny, k = 1 + ts * C.FOLLOW_K * vn, c2 = (1 + C.E_BALL) * 0.5 * vn;
        let tx = dx * k - nx * c2, ty = dy * k - ny * c2; const mag = Math.sqrt(tx * tx + ty * ty);
        const len = Math.max(8, Math.min(190, 150 * mag));
        if (mag > 0.012) out.deflect = [{ x: gx, y: gy }, { x: gx + tx / mag * len, y: gy + ty / mag * len }];
        out.deflectMag = mag;
      }
    } else if (tw < 1e8) {
      const wx = cue.x + dx * tw, wy = cue.y + dy * tw;
      out.path = [{ x: cue.x, y: cue.y }, { x: wx, y: wy }];
      out.ghost = { x: wx, y: wy, wall: true };
      if (mode !== 'short') {
        const rx = wall === 'x' ? -dx : dx, ry = wall === 'y' ? -dy : dy;
        out.bounce = [{ x: wx, y: wy }, { x: wx + rx * 140, y: wy + ry * 140 }];
      }
    }
    return out;
  }

  function create(canvas) {
    const g = canvas.getContext('2d');
    const state = {
      w: 0, h: 0, dpr: 1, s: 1, ox: 0, oy: 0, portrait: false,
      theme: { felt: 'classic', scene: 'bar', cue: 'maple', bigNumbers: false, colorAssist: false },
      table: null, scene: null, noise: null, rolls: {}, lut: null, sprites: {}
    };

    function setTheme(t) { Object.assign(state.theme, t || {}); state.table = null; state.scene = null; }

    function resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2.5, (typeof window!=="undefined"?window.devicePixelRatio:1) || 1);
      state.dpr = dpr;
      state.w = Math.max(10, Math.round(r.width)); state.h = Math.max(10, Math.round(r.height));
      canvas.width = Math.round(state.w * dpr); canvas.height = Math.round(state.h * dpr);
      state.portrait = state.h > state.w * 1.02;
      const tw = W + 2 * FR, th = H + 2 * FR;
      const pad = 6;
      const bw = state.portrait ? th : tw, bh = state.portrait ? tw : th;
      state.s = Math.min((state.w - pad * 2) / bw, (state.h - pad * 2) / bh);
      state.ox = (state.w - bw * state.s) / 2; state.oy = (state.h - bh * state.s) / 2;
      state.table = null; state.scene = null; state.lut = null; state.sprites = {};
    }
    // 桌面座標 → 畫面（css px）
    function toScreen(x, y) {
      const s = state.s;
      if (!state.portrait) return { x: state.ox + (x + FR) * s, y: state.oy + (y + FR) * s };
      return { x: state.ox + (H - y + FR) * s, y: state.oy + (x + FR) * s };
    }
    function toTable(px, py) {
      const s = state.s;
      if (!state.portrait) return { x: (px - state.ox) / s - FR, y: (py - state.oy) / s - FR };
      return { x: (py - state.oy) / s - FR, y: H - ((px - state.ox) / s - FR) };
    }
    // 把桌面向量轉成畫面向量（不含平移）
    function vecToScreen(dx, dy) { return state.portrait ? { x: -dy, y: dx } : { x: dx, y: dy }; }
    function applyTableTransform(ctx) {
      const s = state.s * state.dpr;
      if (!state.portrait) ctx.setTransform(s, 0, 0, s, (state.ox + FR * state.s) * state.dpr, (state.oy + FR * state.s) * state.dpr);
      else ctx.setTransform(0, s, -s, 0, (state.ox + (H + FR) * state.s) * state.dpr, (state.oy + FR * state.s) * state.dpr);
    }

    /* ---------- 場景背景（快取） ---------- */
    function buildScene() {
      const sc = Themes.SCENES[state.theme.scene] || Themes.SCENES.bar;
      const cv = document.createElement('canvas'); cv.width = canvas.width; cv.height = canvas.height;
      const c = cv.getContext('2d'); c.scale(state.dpr, state.dpr);
      const w = state.w, h = state.h, rnd = mulberry(77 + state.theme.scene.length);
      const gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, sc.top); gr.addColorStop(1, sc.bottom);
      c.fillStyle = gr; c.fillRect(0, 0, w, h);
      // 地板
      c.save(); c.globalAlpha = 0.16; c.strokeStyle = '#000'; c.lineWidth = 1;
      if (sc.floor === 'plank') for (let x = 0; x < w; x += 46) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
      else if (sc.floor === 'tile') { for (let x = 0; x < w; x += 70) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); } for (let y = 0; y < h; y += 70) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); } }
      c.restore();
      // 吊燈光暈
      const lamp = hex(sc.lamp);
      const cone = c.createRadialGradient(w / 2, h * 0.38, 10, w / 2, h * 0.45, Math.max(w, h) * 0.75);
      cone.addColorStop(0, 'rgba(' + lamp + ',0.34)'); cone.addColorStop(0.45, 'rgba(' + lamp + ',0.1)'); cone.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = cone; c.fillRect(0, 0, w, h);
      // 散景
      const bk = hex(sc.bokeh);
      for (let i = 0; i < 26; i++) {
        const x = rnd() * w, y = rnd() * h, rr = 8 + rnd() * 34;
        c.fillStyle = 'rgba(' + bk + ',' + (0.03 + rnd() * 0.07) + ')'; c.beginPath(); c.arc(x, y, rr, 0, TWO_PI); c.fill();
      }
      const vg = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.6)');
      c.fillStyle = vg; c.fillRect(0, 0, w, h);
      state.scene = cv;
    }

    /* ---------- 桌面（快取） ---------- */
    function noiseTile() {
      if (state.noise) return state.noise;
      const n = document.createElement('canvas'); n.width = n.height = 96;
      const c = n.getContext('2d'), id = c.createImageData(96, 96), rnd = mulberry(5);
      for (let i = 0; i < id.data.length; i += 4) { const v = rnd() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 26; }
      c.putImageData(id, 0, 0); state.noise = n; return n;
    }
    function buildTable() {
      const felt = Themes.FELTS[state.theme.felt] || Themes.FELTS.classic;
      const cv = document.createElement('canvas'); cv.width = canvas.width; cv.height = canvas.height;
      const c = cv.getContext('2d'); applyTableTransform(c);
      const rnd = mulberry(11);
      // 木框
      const ow = W + 2 * FR, oh = H + 2 * FR;
      const wood = c.createLinearGradient(-FR, -FR, -FR, H + FR); wood.addColorStop(0, '#8a542b'); wood.addColorStop(0.5, '#6a3b1b'); wood.addColorStop(1, '#4a2610');
      c.shadowColor = 'rgba(0,0,0,0.65)'; c.shadowBlur = 26 * state.s * state.dpr * 0.25; c.shadowOffsetY = 8;
      rr(c, -FR, -FR, ow, oh, 40); c.fillStyle = wood; c.fill();
      c.shadowColor = 'transparent';
      // 木紋
      c.save(); rr(c, -FR, -FR, ow, oh, 40); c.clip();
      for (let i = 0; i < 90; i++) {
        const y = -FR + rnd() * oh, a = 0.05 + rnd() * 0.12;
        c.strokeStyle = rnd() < 0.5 ? 'rgba(0,0,0,' + a + ')' : 'rgba(255,210,150,' + a * 0.6 + ')'; c.lineWidth = 0.6 + rnd() * 1.6;
        c.beginPath(); c.moveTo(-FR, y); c.bezierCurveTo(250, y + rnd() * 14 - 7, 700, y + rnd() * 14 - 7, W + FR, y + rnd() * 10 - 5); c.stroke();
      }
      // 上緣高光
      const hl = c.createLinearGradient(0, -FR, 0, -FR + 26); hl.addColorStop(0, 'rgba(255,230,190,0.28)'); hl.addColorStop(1, 'rgba(255,230,190,0)');
      c.fillStyle = hl; c.fillRect(-FR, -FR, ow, 26);
      c.restore();
      // 內緣黃銅細線
      c.strokeStyle = 'rgba(214,170,80,0.55)'; c.lineWidth = 2.2; rr(c, -CUSH - 12, -CUSH - 12, W + 2 * CUSH + 24, H + 2 * CUSH + 24, 18); c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 3; rr(c, -CUSH - 5, -CUSH - 5, W + 2 * CUSH + 10, H + 2 * CUSH + 10, 12); c.stroke();
      // 桌布底色
      const cx = W * 0.5, cy = H * 0.42;
      const fg = c.createRadialGradient(cx, cy, 30, cx, H / 2, W * 0.62);
      fg.addColorStop(0, felt.c1); fg.addColorStop(0.55, felt.c2); fg.addColorStop(1, felt.c3);
      c.fillStyle = fg; c.fillRect(-CUSH, -CUSH, W + 2 * CUSH, H + 2 * CUSH);
      // 桌布紋理
      c.save(); c.beginPath(); c.rect(-CUSH, -CUSH, W + 2 * CUSH, H + 2 * CUSH); c.clip();
      const pat = c.createPattern(noiseTile(), 'repeat'); c.globalAlpha = 0.9; c.fillStyle = pat; c.fillRect(-CUSH, -CUSH, W + 2 * CUSH, H + 2 * CUSH);
      c.restore();
      // 庫邊橡膠（梯形，靠袋口處斜切）
      const cg = C.CORNER_GAP, sg = C.SIDE_GAP;
      function cushion(pts) {
        c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.closePath();
        c.fillStyle = felt.cushion; c.fill(); c.strokeStyle = felt.cushionDark; c.lineWidth = 2.5; c.stroke();
      }
      const bev = 30;
      cushion([[cg, 0], [W / 2 - sg, 0], [W / 2 - sg + bev, -CUSH], [cg - bev, -CUSH]]);
      cushion([[W / 2 + sg, 0], [W - cg, 0], [W - cg + bev, -CUSH], [W / 2 + sg - bev, -CUSH]]);
      cushion([[cg, H], [W / 2 - sg, H], [W / 2 - sg + bev, H + CUSH], [cg - bev, H + CUSH]]);
      cushion([[W / 2 + sg, H], [W - cg, H], [W - cg + bev, H + CUSH], [W / 2 + sg - bev, H + CUSH]]);
      cushion([[0, cg], [0, H - cg], [-CUSH, H - cg + bev], [-CUSH, cg - bev]]);
      cushion([[W, cg], [W, H - cg], [W + CUSH, H - cg + bev], [W + CUSH, cg - bev]]);
      // 庫邊高光
      c.strokeStyle = 'rgba(255,255,255,0.14)'; c.lineWidth = 1.5;
      [[cg, 0, W / 2 - sg, 0], [W / 2 + sg, 0, W - cg, 0], [cg, H, W / 2 - sg, H], [W / 2 + sg, H, W - cg, H], [0, cg, 0, H - cg], [W, cg, W, H - cg]].forEach(l => { c.beginPath(); c.moveTo(l[0], l[1]); c.lineTo(l[2], l[3]); c.stroke(); });
      // 袋口
      P.POCKETS.forEach((p, i) => {
        const rad = (p.corner ? 36 : 33), px = p.x + (p.corner ? (p.x ? 7 : -7) : 0), py = p.y + (p.y ? 9 : -9) * (p.corner ? 0.8 : 1);
        const sx = p.corner ? px : p.x, sy = p.corner ? (p.y ? H + 7 : -7) : (p.y ? H + 9 : -9);
        const rim = c.createRadialGradient(sx, sy, rad * 0.7, sx, sy, rad + 8); rim.addColorStop(0, '#5a2d14'); rim.addColorStop(0.6, '#7a4220'); rim.addColorStop(1, 'rgba(60,30,10,0)');
        c.fillStyle = rim; c.beginPath(); c.arc(sx, sy, rad + 8, 0, TWO_PI); c.fill();
        const hole = c.createRadialGradient(sx - 4, sy - 4, 2, sx, sy, rad); hole.addColorStop(0, '#1b1511'); hole.addColorStop(1, '#030201');
        c.fillStyle = hole; c.beginPath(); c.arc(sx, sy, rad, 0, TWO_PI); c.fill();
        c.strokeStyle = 'rgba(214,170,80,0.7)'; c.lineWidth = 2.4; c.beginPath(); c.arc(sx, sy, rad + 1, 0, TWO_PI); c.stroke();
      });
      // 瞄準標示（鑽石）
      c.fillStyle = '#efe3c4';
      for (let k = 1; k < 8; k++) {
        if (k === 4) continue;
        diamond(c, W / 8 * k, -CUSH - 17); diamond(c, W / 8 * k, H + CUSH + 17);
      }
      for (let k = 1; k < 4; k++) { diamond(c, -CUSH - 17, H / 4 * k); diamond(c, W + CUSH + 17, H / 4 * k); }
      // 開球線與置球點
      c.strokeStyle = 'rgba(255,255,255,0.16)'; c.lineWidth = 1.6; c.setLineDash([6, 8]);
      c.beginPath(); c.moveTo(C.HEAD_X, 0); c.lineTo(C.HEAD_X, H); c.stroke(); c.setLineDash([]);
      c.fillStyle = 'rgba(255,255,255,0.28)';
      [[C.HEAD_X, H / 2], [W / 2, H / 2], [C.FOOT_X, H / 2]].forEach(s => { c.beginPath(); c.arc(s[0], s[1], 2.6, 0, TWO_PI); c.fill(); });
      state.table = cv;
    }
    function diamond(c, x, y) { c.beginPath(); c.moveTo(x, y - 6.5); c.lineTo(x + 4.2, y); c.lineTo(x, y + 6.5); c.lineTo(x - 4.2, y); c.closePath(); c.fill(); }
    function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

    /* ---------- 球 ---------- */
    function getLut() {
      if (state.lut) return state.lut;
      const rpx = R * state.s * state.dpr, size = Math.ceil(rpx * 2) + 4, n = size * size;
      const nx = new Float32Array(n), ny = new Float32Array(n), nz = new Float32Array(n), dif = new Float32Array(n), spc = new Float32Array(n), al = new Float32Array(n);
      const L = [-0.42, -0.52, 0.74], ll = Math.hypot(L[0], L[1], L[2]); L[0] /= ll; L[1] /= ll; L[2] /= ll;
      const Hh = [L[0], L[1], L[2] + 1]; const hl = Math.hypot(Hh[0], Hh[1], Hh[2]); Hh[0] /= hl; Hh[1] /= hl; Hh[2] /= hl;
      const cx = size / 2, cy = size / 2;
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
        const k = j * size + i, u = (i + 0.5 - cx) / rpx, v = (j + 0.5 - cy) / rpx, r2 = u * u + v * v;
        const r = Math.sqrt(r2);
        al[k] = clamp01((1 - r) * rpx + 0.5);
        if (al[k] <= 0) continue;
        const z = Math.sqrt(Math.max(0, 1 - r2));
        nx[k] = u; ny[k] = v; nz[k] = z;
        const d = Math.max(0, u * L[0] + v * L[1] + z * L[2]);
        const edge = 0.55 + 0.45 * Math.pow(z, 0.55);
        dif[k] = (0.3 + 0.78 * d) * edge;
        spc[k] = Math.pow(Math.max(0, u * Hh[0] + v * Hh[1] + z * Hh[2]), 46) * 0.85;
      }
      state.lut = { size, n, nx, ny, nz, dif, spc, al, rpx };
      return state.lut;
    }
    function rollOf(id) {
      let r = state.rolls[id];
      if (!r) {
        const a = (id * 2.399) % TWO_PI, ca = Math.cos(a), sa = Math.sin(a);
        r = state.rolls[id] = { M: [ca, -sa, 0, sa, ca, 0, 0, 0, 1], lx: null, ly: null, dirty: true, n: 0 };
        if (id === 0) r.M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      }
      return r;
    }
    function updateRoll(b) {
      const r = rollOf(b.id);
      if (r.lx != null) {
        const dx = b.x - r.lx, dy = b.y - r.ly, d = Math.hypot(dx, dy);
        if (d > 0.004 && d < 40) {
          const sv = vecToScreen(dx, dy), ux = sv.x / d, uy = sv.y / d, th = d / R, ct = Math.cos(th), st = Math.sin(th);
          const ax = -uy, ay = ux, az = 0, oc = 1 - ct;
          // Rodrigues 旋轉矩陣
          const Rm = [ct + ax * ax * oc, ax * ay * oc - az * st, ax * az * oc + ay * st,
            ay * ax * oc + az * st, ct + ay * ay * oc, ay * az * oc - ax * st,
            az * ax * oc - ay * st, az * ay * oc + ax * st, ct + az * az * oc];
          const M = r.M, N = new Array(9);
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) N[i * 3 + j] = Rm[i * 3] * M[j] + Rm[i * 3 + 1] * M[3 + j] + Rm[i * 3 + 2] * M[6 + j];
          r.M = N; r.dirty = true;
          if (++r.n % 120 === 0) orthonormalize(r);
        }
      }
      r.lx = b.x; r.ly = b.y;
      return r;
    }
    function orthonormalize(r) {
      const M = r.M; let a = [M[0], M[3], M[6]], b = [M[1], M[4], M[7]];
      const la = Math.hypot(a[0], a[1], a[2]); a = a.map(v => v / la);
      const dt = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; b = [b[0] - dt * a[0], b[1] - dt * a[1], b[2] - dt * a[2]];
      const lb = Math.hypot(b[0], b[1], b[2]); b = b.map(v => v / lb);
      const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      r.M = [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
    }
    const RGB = {}; Object.keys(Themes.BALLC).forEach(k => { RGB[k] = hex(Themes.BALLC[k]); });
    const WHITE = [246, 241, 228];
    function spriteOf(id) {
      const lut = getLut();
      let sp = state.sprites[id];
      if (!sp) {
        const cv = document.createElement('canvas'); cv.width = cv.height = lut.size;
        sp = state.sprites[id] = { cv, ctx: cv.getContext('2d'), img: null };
        sp.img = sp.ctx.createImageData(lut.size, lut.size);
      }
      return sp;
    }
    function shade(id, r) {
      const lut = getLut(), sp = spriteOf(id), d = sp.img.data, M = r.M;
      const base = RGB[id === 0 ? 0 : (id <= 8 ? id : id - 8)], stripe = id >= 9, num = id > 0;
      const { n, nx, ny, nz, dif, spc, al } = lut;
      for (let k = 0; k < n; k++) {
        const o = k * 4;
        if (al[k] <= 0) { d[o + 3] = 0; continue; }
        const qx = M[0] * nx[k] + M[3] * ny[k] + M[6] * nz[k], qy = M[1] * nx[k] + M[4] * ny[k] + M[7] * nz[k], qz = M[2] * nx[k] + M[5] * ny[k] + M[8] * nz[k];
        let cr = base[0], cg = base[1], cb = base[2];
        if (stripe) {
          const t = clamp01((0.54 - Math.abs(qy)) / 0.035);
          cr = WHITE[0] + (cr - WHITE[0]) * t; cg = WHITE[1] + (cg - WHITE[1]) * t; cb = WHITE[2] + (cb - WHITE[2]) * t;
        }
        if (num) {
          const t = clamp01((Math.abs(qz) - 0.8) / 0.03);
          cr += (WHITE[0] - cr) * t; cg += (WHITE[1] - cg) * t; cb += (WHITE[2] - cb) * t;
        } else {
          const m = Math.max(Math.abs(qx), Math.abs(qy), Math.abs(qz)), t = clamp01((m - 0.985) / 0.006);
          if (t > 0) { cr += (205 - cr) * t * 0.8; cg += (70 - cg) * t * 0.8; cb += (70 - cb) * t * 0.8; }
        }
        const f = dif[k], s = spc[k] * 255;
        d[o] = Math.min(255, cr * f + s); d[o + 1] = Math.min(255, cg * f + s); d[o + 2] = Math.min(255, cb * f + s);
        d[o + 3] = al[k] * 255;
      }
      sp.ctx.putImageData(sp.img, 0, 0);
      r.dirty = false;
      return sp;
    }

    function drawBall(b, scale, alpha, lift) {
      const r = updateRoll(b);
      let sp = state.sprites[b.id];
      if (!sp || r.dirty) sp = shade(b.id, r);
      const p = toScreen(b.x, b.y), lut = getLut(), sz = lut.size / state.dpr * (scale || 1);
      if (lift) p.y -= lift;
      g.save();
      if (alpha != null) g.globalAlpha = alpha;
      g.drawImage(sp.cv, p.x - sz / 2, p.y - sz / 2, sz, sz);
      g.restore();
      if (b.id > 0) drawNumbers(b, r, p, scale || 1, alpha);
    }
    function drawNumbers(b, r, p, scale, alpha) {
      const M = r.M, rpx = R * state.s * scale;
      for (const sgn of [1, -1]) {
        const vx = M[2] * sgn, vy = M[5] * sgn, vz = M[8] * sgn;
        if (vz < 0.32) continue;
        const cx = p.x + vx * rpx, cy = p.y + vy * rpx;
        const ang = Math.atan2(vy, vx), len = Math.hypot(vx, vy);
        g.save(); if (alpha != null) g.globalAlpha = alpha;
        g.translate(cx, cy);
        // 數字隨球面轉動：沿徑向壓扁
        const spinA = Math.atan2(M[1], M[0]) * 0 + 0;
        g.rotate(len > 0.05 ? ang : 0); g.scale(Math.max(0.25, vz), 1);
        g.rotate(len > 0.05 ? -ang : 0);
        const big = state.theme.bigNumbers ? 1.2 : 1;
        g.fillStyle = '#16120f'; g.textAlign = 'center'; g.textBaseline = 'middle';
        const fs = rpx * (b.id > 9 ? 0.56 : 0.68) * big;
        g.font = '700 ' + fs + 'px "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif';
        g.fillText(String(b.id), 0, rpx * 0.03);
        g.restore();
      }
    }
    function drawShadow(b, scale) {
      if (b.air > 0 && b.air0 > 0) { const f = 1 - b.air / b.air0; scale = (scale || 1) * (1 - 0.35 * 4 * f * (1 - f)); }
      const p = toScreen(b.x, b.y), rpx = R * state.s * (scale || 1);
      const sh = vecToScreen(3, 5);
      const gr = g.createRadialGradient(p.x + sh.x * state.s * 0.9, p.y + sh.y * state.s * 0.9, rpx * 0.2, p.x + sh.x * state.s * 0.9, p.y + sh.y * state.s * 0.9, rpx * 1.35);
      gr.addColorStop(0, 'rgba(0,0,0,0.42)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(p.x + sh.x * state.s * 0.9, p.y + sh.y * state.s * 0.9, rpx * 1.35, 0, TWO_PI); g.fill();
    }

    /* ---------- 球桿 ---------- */
    function drawCue(cue) {
      const K = Themes.CUES[cue.skin] || Themes.CUES.maple;
      const L = 760, a = R + 8 + cue.pull, ang = Math.atan2(cue.dy, cue.dx);
      g.save(); applyTableTransform(g);
      g.translate(cue.x, cue.y); g.rotate(ang);
      if (cue.alpha != null) g.globalAlpha = cue.alpha;
      const hw = d => 3.6 + (8.6 - 3.6) * (d / L);
      function seg(d0, d1, fill) {
        g.beginPath(); g.moveTo(-a - d0, -hw(d0)); g.lineTo(-a - d1, -hw(d1)); g.lineTo(-a - d1, hw(d1)); g.lineTo(-a - d0, hw(d0)); g.closePath();
        g.fillStyle = fill; g.fill();
      }
      // 影子
      g.save(); g.translate(5, 9); g.globalAlpha *= 0.28; g.fillStyle = '#000';
      g.beginPath(); g.moveTo(-a, -hw(0)); g.lineTo(-a - L, -hw(L)); g.lineTo(-a - L, hw(L)); g.lineTo(-a, hw(0)); g.closePath(); g.fill(); g.restore();
      seg(0, 7, K.tip); seg(7, 30, '#f4efe2'); seg(30, 430, K.shaft); seg(430, 462, K.mid); seg(462, L - 4, K.butt);
      seg(520, 534, K.ring); seg(596, 608, K.ring);
      // 圓柱高光
      const gl = g.createLinearGradient(0, -9, 0, 9); gl.addColorStop(0, 'rgba(255,255,255,0.32)'); gl.addColorStop(0.4, 'rgba(255,255,255,0)'); gl.addColorStop(1, 'rgba(0,0,0,0.3)');
      g.beginPath(); g.moveTo(-a, -hw(0)); g.lineTo(-a - L, -hw(L)); g.lineTo(-a - L, hw(L)); g.lineTo(-a, hw(0)); g.closePath(); g.fillStyle = gl; g.fill();
      g.restore();
    }

    /* ---------- 主繪製 ---------- */
    function ring(x, y, rad, color, width, dash) {
      const p = toScreen(x, y);
      g.save(); g.strokeStyle = color; g.lineWidth = width * state.s; if (dash) g.setLineDash(dash.map(v => v * state.s));
      g.beginPath(); g.arc(p.x, p.y, rad * state.s, 0, TWO_PI); g.stroke(); g.restore();
    }
    function line(pts, color, width, dash) {
      if (!pts || pts.length < 2) return;
      const a = toScreen(pts[0].x, pts[0].y), b = toScreen(pts[1].x, pts[1].y);
      g.save(); g.strokeStyle = color; g.lineWidth = width * state.s; g.lineCap = 'round';
      if (dash) g.setLineDash(dash.map(v => v * state.s));
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.restore();
    }

    function draw(sc, now) {
      if (!state.scene) buildScene();
      if (!state.table) buildTable();
      g.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      g.drawImage(state.scene, 0, 0, state.w, state.h);
      g.drawImage(state.table, 0, 0, state.w, state.h);
      const t = (now || 0) / 1000;
      // 指定袋口（八號球）
      if (sc.pocketCall) {
        const pc = sc.pocketCall;
        P.POCKETS.forEach((p, i) => {
          const px = p.x + (p.corner ? (p.x ? 8 : -8) : 0), py = p.y + (p.corner ? (p.y ? 8 : -8) : (p.y ? 12 : -12));
          if (pc.selectable) {
            if (pc.selected === i) { ring(px, py, 44, 'rgba(255,214,102,0.95)', 5); const q = toScreen(px, py); g.fillStyle = 'rgba(255,214,102,0.22)'; g.beginPath(); g.arc(q.x, q.y, 44 * state.s, 0, TWO_PI); g.fill(); }
            else ring(px, py, 44, 'rgba(255,214,102,' + (0.55 + 0.35 * Math.sin(t * 4)) + ')', 3.6, [9, 8]);
          } else if (pc.selected === i) ring(px, py, 44, 'rgba(255,214,102,0.9)', 4);
        });
      }
      // 瞄準線（畫在球下面）
      const bl = sc.balls;
      if (sc.aim) {
        const A = sc.aim;
        if (A.lines.jump) {                           // 跳桿：飛行段畫成拱形虛線，落點畫黃色圈
          const J = A.lines.jump, a = toScreen(J.from.x, J.from.y), b2 = toScreen(J.to.x, J.to.y);
          const mx = (a.x + b2.x) / 2, my = (a.y + b2.y) / 2 - Math.hypot(b2.x - a.x, b2.y - a.y) * 0.22;
          g.save(); g.strokeStyle = 'rgba(255,214,102,0.95)'; g.lineWidth = 2.6 * state.s; g.setLineDash([4 * state.s, 7 * state.s]); g.lineCap = 'round';
          g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(mx, my, b2.x, b2.y); g.stroke(); g.restore();
          ring(J.to.x, J.to.y, R + 3, 'rgba(255,214,102,0.95)', 2.6, [5, 4]);
        }
        if (A.lines.path.length) line(A.lines.path, 'rgba(255,255,255,0.82)', 2.4, [10, 8]);
        if (A.lines.target) line(A.lines.target, 'rgba(255,225,120,0.9)', 2.6, [8, 7]);
        if (A.lines.deflect) line(A.lines.deflect, 'rgba(255,255,255,0.4)', 2, [5, 7]);
        if (A.lines.bounce) line(A.lines.bounce, 'rgba(255,255,255,0.35)', 2, [5, 7]);
        if (A.lines.ghost) ring(A.lines.ghost.x, A.lines.ghost.y, R, 'rgba(255,255,255,0.85)', 2);
      }
      // 球：影子 → 本體
      for (const b of bl) { if (b.pocket < 0) drawShadow(b); }
      // 自由球虛框
      if (sc.hand) ring(sc.hand.x, sc.hand.y, R + 6, sc.hand.ok ? 'rgba(120,255,160,0.9)' : 'rgba(255,90,80,0.95)', 3);
      for (const b of bl) { if (b.pocket < 0 && b.id !== 0) drawBall(b); }
      for (const b of bl) {
        if (b.pocket < 0 && b.id === 0) {
          let sc2 = 1, lift = 0;
          if (b.air > 0 && b.air0 > 0) { const f = 1 - b.air / b.air0, hh = 4 * f * (1 - f); sc2 = 1 + 0.28 * hh; lift = hh * R * state.s * 2.2; }
          drawBall(b, sc2, sc.hand && !sc.hand.ok ? 0.55 : null, lift);
        }
      }
      // 進袋動畫
      if (sc.dropping) for (const d of sc.dropping) {
        const k = clamp01(d.t), pp = P.POCKETS[d.pocket];
        const x = d.x + (pp.x - d.x) * k * 0.85, y = d.y + (pp.y - d.y) * k * 0.85;
        drawBall({ id: d.id, x, y }, 1 - k * 0.7, 1 - k * 0.9);
      }
      // 球桿
      if (sc.cue && sc.cue.show) drawCue(sc.cue);
      // 位置標記（呼叫指定）
      if (sc.marks) for (const m of sc.marks) ring(m.x, m.y, m.r, m.color, m.w || 2.5, m.dash);
    }

    resize();
    return { resize, setTheme, draw, toScreen, toTable, vecToScreen, state, FR, aimLines,
      pocketHit(px, py) {
        const t = toTable(px, py);
        let best = -1, bd = 1e9;
        P.POCKETS.forEach((p, i) => { const cx = p.x + (p.corner ? (p.x ? 8 : -8) : 0), cy = p.y + (p.corner ? (p.y ? 8 : -8) : (p.y ? 12 : -12)); const d = Math.hypot(t.x - cx, t.y - cy); if (d < bd) { bd = d; best = i; } });
        return bd < 70 ? best : -1;
      },
      resetRolls() { state.rolls = {}; }
    };
  }

  return { create, aimLines, FR };
});
