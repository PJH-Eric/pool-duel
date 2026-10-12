/* 確定性撞球物理：純函式、無 DOM、無時間依賴。瀏覽器、伺服器、AI 共用。
   模擬內只用 + − × ÷ Math.sqrt（IEEE 規範，各端結果一致）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./physics-config.js'));
  else root.PoolPhysics = factory(root.PoolConfig);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  var R = C.R, W = C.W, H = C.H, SQRT3 = 1.7320508075688772;

  // 袋口：0 左上 1 上中 2 右上 3 左下 4 下中 5 右下
  var POCKETS = [
    { x: 0, y: 0, corner: true }, { x: W / 2, y: 0, corner: false }, { x: W, y: 0, corner: true },
    { x: 0, y: H, corner: true }, { x: W / 2, y: H, corner: false }, { x: W, y: H, corner: true }
  ];
  var CG = C.CORNER_GAP, SG = C.SIDE_GAP, JR = C.JAW_R;
  var JAWS = [
    [CG, -JR], [-JR, CG], [W - CG, -JR], [W + JR, CG],
    [CG, H + JR], [-JR, H - CG], [W - CG, H + JR], [W + JR, H - CG],
    [W / 2 - SG, -JR], [W / 2 + SG, -JR], [W / 2 - SG, H + JR], [W / 2 + SG, H + JR]
  ];

  function capRadius(p, scale) { return (p.corner ? C.CAP_CORNER : C.CAP_SIDE) * scale; }

  function makeWorld(balls, opts) {
    opts = opts || {};
    var w = {
      balls: [], t: 0, events: [], recordEvents: opts.recordEvents !== false,
      pocketScale: opts.pocketScale || 1, ctx: null
    };
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      w.balls.push({ id: b.id, x: b.x, y: b.y, vx: 0, vy: 0, pocket: b.pocket == null ? -1 : b.pocket, ts: 0, ss: 0, spinUsed: false, slv: 0, air: 0, air0: 0 });
    }
    resetCtx(w);
    return w;
  }
  function resetCtx(w) {
    w.t = 0; w.events.length = 0;
    w.ctx = { firstContact: -1, pocketed: [], railAfterContact: false, railBalls: [], railBallsAfterContact: [], hitOrder: [] };
  }
  function ball(w, id) { for (var i = 0; i < w.balls.length; i++) if (w.balls[i].id === id) return w.balls[i]; return null; }

  function pushUnique(arr, v) { if (arr.indexOf(v) < 0) arr.push(v); }

  function ev(w, e) { if (w.recordEvents) { e.t = w.t; w.events.push(e); } }

  function pocketBall(w, b, pi) {
    b.pocket = pi; b.vx = 0; b.vy = 0;
    w.ctx.pocketed.push({ id: b.id, pocket: pi, order: w.ctx.pocketed.length });
    ev(w, { type: 'pocket', ball: b.id, pocket: pi, x: b.x, y: b.y });
  }

  function railHit(w, b, vn) {
    if (b.id > 0) pushUnique(w.ctx.railBalls, b.id);
    if (w.ctx.firstContact >= 0) {
      w.ctx.railAfterContact = true;
      if (b.id > 0) pushUnique(w.ctx.railBallsAfterContact, b.id);
    }
    if (vn > 8) ev(w, { type: 'rail', ball: b.id, speed: vn, x: b.x, y: b.y });
  }

  function spinKick(b, vnPre) {
    if (b.id !== 0 || b.ss === 0) return;
    var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (sp < 1) return;
    var ux = b.vx / sp, uy = b.vy / sp;
    var rx = -uy, ry = ux; // 行進方向右手邊（y 朝下的畫面座標）
    var k = b.ss * C.SIDE_K * vnPre;
    var nx = b.vx + rx * k, ny = b.vy + ry * k;
    var ns = Math.sqrt(nx * nx + ny * ny);
    if (ns > sp) { nx = nx / ns * sp; ny = ny / ns * sp; }
    b.vx = nx; b.vy = ny; b.ss = b.ss * 0.5;
  }

  function wallCollide(w, b) {
    var inTopSeg = (b.x >= CG && b.x <= W / 2 - SG) || (b.x >= W / 2 + SG && b.x <= W - CG);
    var inSideSeg = b.y >= CG && b.y <= H - CG;
    var vn;
    if (inTopSeg) {
      if (b.y < R) {
        b.y = R;
        if (b.vy < 0) { vn = -b.vy; b.vy = vn * C.E_RAIL_N; b.vx *= C.E_RAIL_T; spinKick(b, vn); railHit(w, b, vn); }
      } else if (b.y > H - R) {
        b.y = H - R;
        if (b.vy > 0) { vn = b.vy; b.vy = -vn * C.E_RAIL_N; b.vx *= C.E_RAIL_T; spinKick(b, vn); railHit(w, b, vn); }
      }
    }
    if (inSideSeg) {
      if (b.x < R) {
        b.x = R;
        if (b.vx < 0) { vn = -b.vx; b.vx = vn * C.E_RAIL_N; b.vy *= C.E_RAIL_T; spinKick(b, vn); railHit(w, b, vn); }
      } else if (b.x > W - R) {
        b.x = W - R;
        if (b.vx > 0) { vn = b.vx; b.vx = -vn * C.E_RAIL_N; b.vy *= C.E_RAIL_T; spinKick(b, vn); railHit(w, b, vn); }
      }
    }
  }

  function jawCollide(w, b) {
    var lim = R + JR, lim2 = lim * lim;
    for (var i = 0; i < JAWS.length; i++) {
      var dx = b.x - JAWS[i][0], dy = b.y - JAWS[i][1];
      var d2 = dx * dx + dy * dy;
      if (d2 < lim2 && d2 > 1e-9) {
        var d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        b.x = JAWS[i][0] + nx * lim; b.y = JAWS[i][1] + ny * lim;
        var vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= (1 + C.E_JAW) * vn * nx; b.vy -= (1 + C.E_JAW) * vn * ny;
          railHit(w, b, -vn);
        }
      }
    }
  }

  function ballCollide(w, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, lim = 2 * R;
    var d2 = dx * dx + dy * dy;
    if (d2 >= lim * lim) return;
    var d = Math.sqrt(d2), nx, ny;
    if (d < 1e-9) { nx = 1; ny = 0; d = 0; } else { nx = dx / d; ny = dy / d; }
    var overlap = lim - d;
    if (overlap > 0) { a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5; b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5; }
    var vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (vn <= 0) return;
    var cue = a.id === 0 ? a : (b.id === 0 ? b : null);
    var preVx = cue ? cue.vx : 0, preVy = cue ? cue.vy : 0;
    var j = (1 + C.E_BALL) * 0.5 * vn;
    a.vx -= j * nx; a.vy -= j * ny; b.vx += j * nx; b.vy += j * ny;
    a.slv = C.SLIDE_END * Math.sqrt(a.vx * a.vx + a.vy * a.vy); b.slv = C.SLIDE_END * Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (cue) {
      if (w.ctx.firstContact < 0) w.ctx.firstContact = (cue === a ? b : a).id;
      pushUnique(w.ctx.hitOrder, (cue === a ? b : a).id);
      if (!cue.spinUsed && cue.ts !== 0) {
        var ps = Math.sqrt(preVx * preVx + preVy * preVy);
        if (ps > 1) {
          var add = cue.ts * C.FOLLOW_K * vn;
          cue.vx += preVx / ps * add; cue.vy += preVy / ps * add;
        }
        cue.spinUsed = true;
      }
      cue.slv = C.SLIDE_END * Math.sqrt(cue.vx * cue.vx + cue.vy * cue.vy);
    }
    if (vn > 8) ev(w, { type: 'hit', a: a.id, b: b.id, speed: vn, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }

  // 一個固定步（內含 1～4 個子步）
  function stepWorld(w) {
    var balls = w.balls, n = balls.length, i, j, maxV2 = 0, b;
    for (i = 0; i < n; i++) { b = balls[i]; if (b.pocket >= 0) continue; var v2 = b.vx * b.vx + b.vy * b.vy; if (v2 > maxV2) maxV2 = v2; }
    var maxV = Math.sqrt(maxV2);
    var sub = 1;
    var per = maxV * C.DT;
    while (per / sub > R * 0.45 && sub < 6) sub++;
    var h = C.DT / sub;
    for (var s = 0; s < sub; s++) {
      for (i = 0; i < n; i++) {
        b = balls[i];
        if (b.pocket >= 0) continue;
        if (b.vx !== 0 || b.vy !== 0) {
          b.x += b.vx * h; b.y += b.vy * h;
          var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
          var dcl = C.DECEL_ROLL;
          if (b.air > 0) {                           // 跳桿飛行中：沒有摩擦；時間到就落地
            b.air -= h; dcl = 0;
            if (b.air <= 0) { b.air = 0; b.vx *= C.JUMP_LAND; b.vy *= C.JUMP_LAND; b.slv = C.SLIDE_END * Math.sqrt(b.vx * b.vx + b.vy * b.vy); ev(w, { type: 'land', x: b.x, y: b.y }); }
          }
          else if (b.slv > 0) { if (sp > b.slv) dcl = C.DECEL; else b.slv = 0; }   // 先滑（摩擦大），滑到 5/7 速度後轉純滾動（阻力小）
          var ns = sp - dcl * h;
          if (ns < C.ZERO_V) { b.vx = 0; b.vy = 0; }
          else { var k = ns / sp; b.vx *= k; b.vy *= k; }
          if (b.id === 0) { var dec = 1 - C.SPIN_DECAY * h; b.ts *= dec; b.ss *= dec; }
        }
      }
      for (var pass = 0; pass < 2; pass++) {
        for (i = 0; i < n; i++) {
          var a = balls[i];
          if (a.pocket >= 0) continue;
          for (j = i + 1; j < n; j++) {
            var c = balls[j];
            if (c.pocket >= 0) continue;
            if (a.air > 0 || c.air > 0) continue;       // 飛在空中的母球不會碰到地上的球
            if (a.vx === 0 && a.vy === 0 && c.vx === 0 && c.vy === 0) continue;
            ballCollide(w, a, c);
          }
        }
      }
      for (i = 0; i < n; i++) {
        b = balls[i];
        if (b.pocket >= 0) continue;
        wallCollide(w, b);
        if (b.air > 0) continue;                      // 空中不會進袋、也不會撞袋口尖角
        jawCollide(w, b);
        for (var p = 0; p < 6; p++) {
          var P = POCKETS[p], dx = b.x - P.x, dy = b.y - P.y, cr = capRadius(P, w.pocketScale);
          if (dx * dx + dy * dy < cr * cr) { pocketBall(w, b, p); break; }
        }
        if (b.pocket < 0 && (b.x < -R || b.x > W + R || b.y < -R || b.y > H + R)) {
          var bp = b.x < W / 2 ? (b.y < H / 2 ? 0 : 3) : (b.y < H / 2 ? 2 : 5);
          if (Math.abs(b.x - W / 2) < 60) bp = b.y < H / 2 ? 1 : 4;
          pocketBall(w, b, bp);
        }
      }
      w.t += h;
    }
  }

  function isAtRest(w) {
    for (var i = 0; i < w.balls.length; i++) { var b = w.balls[i]; if (b.pocket < 0 && (b.vx !== 0 || b.vy !== 0)) return false; }
    return true;
  }

  function hashState(w) {
    var h = 2166136261 >>> 0;
    function mix(v) { h ^= (v | 0) & 0xffff; h = Math.imul(h, 16777619) >>> 0; h ^= ((v | 0) >> 16) & 0xffff; h = Math.imul(h, 16777619) >>> 0; }
    for (var i = 0; i < w.balls.length; i++) {
      var b = w.balls[i]; mix(b.id); mix(b.pocket + 1);
      if (b.pocket < 0) { mix(Math.round(b.x * 100)); mix(Math.round(b.y * 100)); }
    }
    return h.toString(16);
  }

  function snapshot(w) {
    var o = [];
    for (var i = 0; i < w.balls.length; i++) { var b = w.balls[i]; o.push({ id: b.id, x: b.x, y: b.y, pocket: b.pocket }); }
    return o;
  }

  // shot: { ax, ay (整數 ×1e6), power (0..1000), sx, sy (-600..600 千分比) }
  function quantizeDir(dx, dy) {
    var l = Math.sqrt(dx * dx + dy * dy);
    if (l < 1e-12) return { ax: 1000000, ay: 0 };
    return { ax: Math.round(dx / l * 1e6), ay: Math.round(dy / l * 1e6) };
  }
  function powerToSpeed(p) {
    var q = p / 1000; if (q < 0) q = 0; if (q > 1) q = 1;
    return C.VMAX * (C.POWER_LIN * q + (1 - C.POWER_LIN) * q * q);
  }
  function applyShot(w, shot) {
    var cue = ball(w, 0);
    var dx = shot.ax / 1e6, dy = shot.ay / 1e6;
    var l = Math.sqrt(dx * dx + dy * dy); dx /= l; dy /= l;
    var sx = (shot.sx || 0) / 1000 / C.SPIN_MAX, sy = (shot.sy || 0) / 1000 / C.SPIN_MAX;
    if (sx > 1) sx = 1; if (sx < -1) sx = -1; if (sy > 1) sy = 1; if (sy < -1) sy = -1;
    // 側旋造成出桿偏移（squirt）：偏向相反側
    var rx = -dy, ry = dx;
    dx -= rx * sx * C.SQUIRT; dy -= ry * sx * C.SQUIRT;
    l = Math.sqrt(dx * dx + dy * dy); dx /= l; dy /= l;
    var v = powerToSpeed(shot.power);
    resetCtx(w);
    cue.air = 0; cue.air0 = 0;
    if (shot.jump) {                                // 跳桿：不帶旋轉，飛行時間 = 距離 / 速度
      sx = 0; sy = 0; cue.vx = dx * v; cue.vy = dy * v;
      var jd = C.JUMP_MIN + C.JUMP_K * Math.min(1, shot.power / 1000);
      cue.air = jd / v; cue.air0 = cue.air;
    }
    cue.vx = dx * v; cue.vy = dy * v; cue.ts = sy; cue.ss = sx; cue.spinUsed = false;
    // 母球剛被擊出時在「滑」：上旋（推桿）滑得少、下旋（拉桿）滑得多
    var rr = C.SLIDE_END + (1 - C.SLIDE_END) * sy; if (rr < 0.4) rr = 0.4; if (rr > 1) rr = 1; cue.slv = shot.jump ? 0 : rr * v;
    ev(w, { type: 'strike', speed: v });
  }

  function collect(w) {
    var cx = w.ctx, cueScratch = false;
    for (var i = 0; i < cx.pocketed.length; i++) if (cx.pocketed[i].id === 0) cueScratch = true;
    return {
      t: w.t, timedOut: !isAtRest(w), firstContact: cx.firstContact, pocketed: cx.pocketed.slice(),
      cueScratch: cueScratch, railAfterContact: cx.railAfterContact,
      railBalls: cx.railBalls.slice(), railBallsAfterContact: cx.railBallsAfterContact.slice(),
      hitOrder: cx.hitOrder.slice(), balls: snapshot(w), hash: hashState(w)
    };
  }

  function runToRest(w, maxTime) {
    maxTime = maxTime || C.MAX_SIM_TIME;
    var guard = Math.ceil(maxTime / C.DT) + 10, steps = 0;
    while (steps++ < guard) { stepWorld(w); if (isAtRest(w)) break; }
    return collect(w);
  }

  // 擺球：回傳 [{id,x,y}]（不含母球）。kind: 'nine' | 'eight' | 'score'
  function rackSlots(apexX, apexY, rows, widths) {
    var out = [], dxr = SQRT3 * R + 0.05, dy = 2 * R + 0.05;
    for (var r = 0; r < rows; r++) {
      var cnt = widths[r];
      for (var k = 0; k < cnt; k++) out.push({ x: apexX + r * dxr, y: apexY + (k - (cnt - 1) / 2) * dy });
    }
    return out;
  }
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  function rack(kind, rngIn) {
    var rng = typeof rngIn === 'function' ? rngIn : function () { return rngIn.next(); };
    var ax = C.FOOT_X, ay = C.CENTER_Y, slots, ids, i;
    if (kind === 'nine') {
      slots = rackSlots(ax, ay, 5, [1, 2, 3, 2, 1]);
      var rest = shuffle([2, 3, 4, 5, 6, 7, 8], rng);
      ids = [1, rest[0], rest[1], rest[2], 9, rest[3], rest[4], rest[5], rest[6]];
    } else if (kind === 'eight') {
      slots = rackSlots(ax, ay, 5, [1, 2, 3, 4, 5]);
      var solids = shuffle([1, 2, 3, 4, 5, 6, 7], rng), stripes = shuffle([9, 10, 11, 12, 13, 14, 15], rng);
      var c1 = solids.pop(), c2 = stripes.pop();
      var pool = shuffle(solids.concat(stripes), rng);
      ids = new Array(15);
      if (rng() < 0.5) { ids[10] = c1; ids[14] = c2; } else { ids[10] = c2; ids[14] = c1; }
      ids[4] = 8;
      var pi = 0;
      for (i = 0; i < 15; i++) if (ids[i] == null) ids[i] = pool[pi++];
    } else {
      slots = rackSlots(ax, ay, 5, [1, 2, 3, 4, 5]);
      ids = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], rng);
    }
    var out = [];
    for (i = 0; i < slots.length; i++) out.push({ id: ids[i], x: slots[i].x, y: slots[i].y, pocket: -1 });
    return out;
  }

  function ballCountFor(kind) { return kind === 'nine' ? 9 : 15; }

  return {
    C: C, POCKETS: POCKETS, JAWS: JAWS, capRadius: capRadius,
    makeWorld: makeWorld, resetCtx: resetCtx, stepWorld: stepWorld, isAtRest: isAtRest, runToRest: runToRest,
    applyShot: applyShot, collect: collect, quantizeDir: quantizeDir, powerToSpeed: powerToSpeed, snapshot: snapshot, hashState: hashState,
    rack: rack, ballCountFor: ballCountFor, ball: ball
  };
});
