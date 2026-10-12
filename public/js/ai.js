/* 電腦對手：四個難度。與遊戲共用同一套物理與規則（用引擎模擬候選桿）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./physics.js'), require('./rules.js'));
  else root.PoolAI = factory(root.PoolPhysics, root.PoolRules);
})(typeof self !== 'undefined' ? self : this, function (P, Rules) {
  'use strict';
  var C = P.C, R = C.R, W = C.W, H = C.H;

  var LEVELS = {
    kids:   { name: '幼幼班', err: 8,   perr: 0.25, sims: 0, spin: false, pos: false, wild: 0.12, nearest: false, think: [900, 1600] },
    easy:   { name: '簡單',   err: 4,   perr: 0.12, sims: 0, spin: false, pos: false, wild: 0.04, nearest: true,  think: [900, 1800] },
    normal: { name: '普通',   err: 1.5, perr: 0.05, sims: 4, spin: false, pos: false, wild: 0,    nearest: false, think: [1200, 2200] },
    hard:   { name: '困難',   err: 0.4, perr: 0.02, sims: 9, spin: true,  pos: true,  wild: 0,    nearest: false, think: [1500, 2500] }
  };

  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    if (t < 0) t = 0; if (t > 1) t = 1;
    var qx = ax + dx * t - px, qy = ay + dy * t - py;
    return Math.sqrt(qx * qx + qy * qy);
  }
  function clear(balls, ax, ay, bx, by, skipIds, margin) {
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i]; if (b.pocket >= 0 || skipIds.indexOf(b.id) >= 0) continue;
      if (segDist(b.x, b.y, ax, ay, bx, by) < 2 * R * margin) return false;
    }
    return true;
  }
  function aimPoint(p, scale) {
    var P0 = P.POCKETS[p];
    if (P0.corner) {
      var dx = W / 2 - P0.x, dy = H / 2 - P0.y, l = Math.sqrt(dx * dx + dy * dy);
      var d = 4 * scale;
      return { x: P0.x + dx / l * d, y: P0.y + dy / l * d };
    }
    return { x: P0.x, y: P0.y === 0 ? 5 : H - 5 };
  }

  // 幾何候選：直接把目標球打進袋
  function potCandidates(state, cue, opts) {
    opts = opts || {};
    var balls = state.balls, out = [];
    var targets = Rules.legalFirstIds(state);
    var needCall = Rules.needCall(state);
    var scale = state.bigPockets ? C.POCKET_SCALE_BIG : 1;
    var cx = cue.x, cy = cue.y;
    for (var ti = 0; ti < targets.length; ti++) {
      var T = Rules.getBall(state, targets[ti]);
      if (!T || T.pocket >= 0) continue;
      // 九球/八球：8 號球在未輪到時不當作目標（legalFirstIds 已處理）
      for (var p = 0; p < 6; p++) {
        var ap = aimPoint(p, scale);
        var tx = ap.x - T.x, ty = ap.y - T.y, d2 = Math.sqrt(tx * tx + ty * ty);
        if (d2 < 1) continue;
        var ux = tx / d2, uy = ty / d2;
        if (!P.POCKETS[p].corner && Math.abs(ux) > 0.8) continue;   // 邊袋角度太斜
        var gx = T.x - ux * 2 * R, gy = T.y - uy * 2 * R;
        if (gx < R - 1 || gx > W - R + 1 || gy < R - 1 || gy > H - R + 1) continue;
        var vx = gx - cx, vy = gy - cy, d1 = Math.sqrt(vx * vx + vy * vy);
        if (d1 < 1) continue;
        var cos = (vx / d1) * ux + (vy / d1) * uy;
        if (cos < 0.2) continue;
        if (!clear(balls, cx, cy, gx, gy, [0, T.id], 1.0)) continue;
        if (!clear(balls, T.x, T.y, ap.x, ap.y, [0, T.id], 1.0)) continue;
        var diff = d1 * 0.0022 + d2 * 0.0045 + (1 - cos) * 3.2 + (P.POCKETS[p].corner ? 0 : 0.5);
        out.push({ target: T.id, pocket: p, gx: gx, gy: gy, dir: { x: vx / d1, y: vy / d1 }, d1: d1, d2: d2, cos: cos, diff: diff });
      }
    }
    out.sort(function (a, b) { return a.diff - b.diff; });
    return out;
  }

  function speedToPower(v) {
    var a = C.POWER_LIN, u = v / C.VMAX; if (u > 1) u = 1;
    var q = (-a + Math.sqrt(a * a + 4 * (1 - a) * u)) / (2 * (1 - a));
    return Math.max(8, Math.min(1000, Math.round(q * 1000)));
  }
  function powerFor(c, extra) {
    var vObj = Math.sqrt(2 * C.DECEL_EFF * (c.d2 + 60)) * 1.05 + 30;
    var vPre = Math.sqrt(vObj * vObj / Math.max(0.35, c.cos) + 2 * C.DECEL_EFF * c.d1) * (extra || 1);
    return speedToPower(vPre);
  }

  function rotate(dir, deg) {
    var a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    return { x: dir.x * ca - dir.y * sa, y: dir.x * sa + dir.y * ca };
  }
  function mkShot(dir, power, sx, sy, cueSpot, call) {
    var q = P.quantizeDir(dir.x, dir.y);
    var s = { ax: q.ax, ay: q.ay, power: Math.max(8, Math.min(1000, Math.round(power))), sx: sx || 0, sy: sy || 0 };
    if (cueSpot) s.cue = { x: Math.round(cueSpot.x * 100) / 100, y: Math.round(cueSpot.y * 100) / 100 };
    if (call != null) {
      if (typeof call === 'object') { if (call.safety) s.safety = 1; else { s.call = call.pocket; s.cb = call.cb; } }
      else s.call = call;
    }
    return s;
  }

  function simulate(state, shot) {
    var w = Rules.prepareWorld(state, shot);
    w.recordEvents = false;
    P.applyShot(w, shot);
    var res = P.runToRest(w);
    return { res: res, info: Rules.evaluateShot(state, shot, res) };
  }

  function ease(state, player) {
    if (state.phase !== 'play') return 0;
    var s2 = { kind: state.kind, balls: state.balls, turn: player, groups: state.groups, bigPockets: state.bigPockets, kids: state.kids, isBreak: false, phase: 'play', hand: null };
    var cue = s2.balls[0];
    if (state.hand && state.hand.player === player) return 120;
    var c = potCandidates(s2, cue), e = 0;
    for (var i = 0; i < Math.min(2, c.length); i++) e += Math.max(0, 1 - c[i].diff / 4.5) * 60;
    return e;
  }

  function scoreOutcome(state, sim, me, L) {
    var info = sim.info, ns = info.state, sc = 0, i;
    if (ns.winner === me) return 1e6;
    if (ns.winner != null && ns.winner >= 0) return -1e6;
    if (ns.winner === -1) return 0;
    var foul = info.fouls.length > 0;
    if (foul) sc -= 400;
    if (info.scratch) sc -= 200;
    if (state.kind === 'score') { sc += (info.pts || 0) * 110; if (info.safety) sc += 30; }
    else {
      var g = state.groups[me];
      for (i = 0; i < info.pocketedObjects.length; i++) {
        var id = info.pocketedObjects[i];
        if (state.kind === 'eight') {
          if (g && Rules.groupOf(id) !== g && id !== 8) sc -= 70; else sc += 110;
        } else sc += 110;
      }
    }
    if (info.continued) sc += 80;
    if (info.pending) sc += (ns.phase === 'choice' ? -50 : 0);
    if (L.pos) {
      if (info.continued) sc += ease(ns, me); else sc -= ease(ns, 1 - me) * 1.1;
    }
    return sc;
  }

  // 球在手：挑一個擺放位置
  function pickPlacement(state, L, rng) {
    var base = { x: C.HEAD_X, y: C.CENTER_Y };
    var spots = [];
    var s2 = { kind: state.kind, balls: state.balls, turn: state.turn, groups: state.groups, bigPockets: state.bigPockets, kids: state.kids, isBreak: false, phase: 'play', hand: null };
    var probe = Rules.legalFirstIds(s2);
    for (var ti = 0; ti < probe.length && spots.length < 80; ti++) {
      var T = Rules.getBall(state, probe[ti]);
      for (var p = 0; p < 6; p++) {
        var ap = aimPoint(p, 1), tx = ap.x - T.x, ty = ap.y - T.y, d = Math.sqrt(tx * tx + ty * ty);
        if (d < 1 || (!P.POCKETS[p].corner && Math.abs(tx / d) > 0.8)) continue;
        var ux = tx / d, uy = ty / d, gx = T.x - ux * 2 * R, gy = T.y - uy * 2 * R;
        [110, 220].forEach(function (back) { spots.push({ x: gx - ux * back, y: gy - uy * back }); });
      }
    }
    if (!spots.length) spots.push({ x: 300, y: 250 });
    var best = null, bs = -1e9, cnt = 0;
    for (var i = 0; i < spots.length; i++) {
      var sp = spots[i];
      var sv = { balls: state.balls, hand: state.hand, bigPockets: state.bigPockets };
      if (!Rules.validCuePlacement(sv, sp.x, sp.y)) continue;
      var c = potCandidates(s2, sp);
      var q = c.length ? 10 - c[0].diff : -5;
      if (state.isBreak) q = -Math.abs(sp.x - 200) * 0.01;
      if (L.pos && c.length > 1) q += 0.6 * (10 - c[1].diff);
      if (q > bs) { bs = q; best = sp; }
      cnt++;
    }
    if (!best) best = Rules.nearestValidCue(state, base.x, base.y);
    if (L === LEVELS.kids || L === LEVELS.easy) {
      if (rng.next() < 0.35) best = Rules.nearestValidCue(state, base.x, base.y);
    }
    return best;
  }

  function chooseShot(state, level, rng) {
    var L = LEVELS[level] || LEVELS.normal, me = state.turn, i, j;
    var cue = state.balls[0], spot = null;
    if (state.hand) { spot = pickPlacement(state, L, rng); cue = { x: spot.x, y: spot.y }; }
    var think = Math.round(L.think[0] + rng.next() * (L.think[1] - L.think[0]));
    var callMode = Rules.needCall(state) ? 'eight' : (Rules.needCallBall(state) ? 'ball' : null);
    function cl(pocket, id) { return callMode === 'eight' ? pocket : (callMode === 'ball' ? { pocket: pocket, cb: id } : null); }
    function noisy(dir, power) {
      var err = (rng.next() * 2 - 1) * L.err;
      var pw = power * (1 + (rng.next() * 2 - 1) * L.perr);
      return { dir: rotate(dir, err), power: pw };
    }
    var simState = state;
    if (spot) { simState = Rules.clone(state); simState.balls[0].x = spot.x; simState.balls[0].y = spot.y; }

    // 開球
    if (state.isBreak) {
      var dirB = { x: C.FOOT_X - cue.x, y: C.CENTER_Y + (rng.next() - 0.5) * 8 - cue.y };
      var l = Math.sqrt(dirB.x * dirB.x + dirB.y * dirB.y); dirB.x /= l; dirB.y /= l;
      var nb = noisy(dirB, state.kids || level === 'kids' ? 780 : (level === 'easy' ? 880 : 1000));
      return { shot: mkShot(nb.dir, nb.power, 0, 0, spot), think: think };
    }

    var cands = potCandidates(Object.assign({}, simState, { balls: simState.balls }), cue);
    var shot = null;

    if (L.wild && rng.next() < L.wild) cands = [];

    if (cands.length) {
      var pick;
      if (L.sims === 0) {
        var pool = cands.slice(0, 6);
        if (L.nearest) pool.sort(function (a, b) { return a.d1 - b.d1; });
        pick = level === 'kids' ? pool[Math.floor(rng.next() * Math.min(3, pool.length))] : pool[0];
        var n = noisy(pick.dir, powerFor(pick, level === 'kids' ? 1.15 : 1.1));
        shot = mkShot(n.dir, n.power, 0, 0, spot, cl(pick.pocket, pick.target));
      } else {
        var best = null, bs = -1e12;
        var K = Math.min(L.sims, cands.length);
        for (i = 0; i < K; i++) {
          var c = cands[i];
          var variants = [[1.05, 0, 0]];
          if (L.spin) variants = [[1.05, 0, 0], [1.3, 0, 0], [1.1, 0, 330], [1.1, 0, -330], [0.9, 0, 0]];
          for (j = 0; j < variants.length; j++) {
            var v = variants[j];
            var sh = mkShot(c.dir, Math.min(1000, powerFor(c, v[0])), v[1], v[2], spot, cl(c.pocket, c.target));
            var sm = simulate(state, sh);
            var sco = scoreOutcome(state, sm, me, L) - c.diff * 4;
            if (sco > bs) { bs = sco; best = { c: c, v: v, sh: sh }; }
          }
        }
        // 輸入誤差在決定之後才加（讓高難度偶有失誤、但不離譜）
        var n2 = noisy(best.c.dir, best.sh.power);
        shot = mkShot(n2.dir, n2.power, best.sh.sx, best.sh.sy, spot, cl(best.c.pocket, best.c.target));
      }
    } else {
      // 沒有乾淨的進球路線：打防守球（合法第一碰、輕力）
      var legal = Rules.legalFirstIds(state), bestS = null, bsS = -1e12;
      var opts = [];
      for (i = 0; i < legal.length; i++) {
        var T = Rules.getBall(state, legal[i]);
        var dx = T.x - cue.x, dy = T.y - cue.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) continue;
        opts.push({ id: T.id, dir: { x: dx / d, y: dy / d }, d: d, clear: clear(simState.balls, cue.x, cue.y, T.x, T.y, [0, T.id], 1.0) });
      }
      opts.sort(function (a, b) { return (b.clear - a.clear) || (a.d - b.d); });
      var pc = callMode === 'eight' ? 0 : (callMode === 'ball' ? { safety: 1 } : null);
      if (L.sims === 0) {
        var o = opts[0] || { dir: { x: 1, y: 0 } };
        var n3 = noisy(o.dir, 420 + rng.next() * 200);
        shot = mkShot(n3.dir, n3.power, 0, 0, spot, pc);
      } else {
        var lim = Math.min(opts.length, L.sims);
        for (i = 0; i < lim; i++) {
          var powers = [260, 420, 620];
          for (j = 0; j < powers.length; j++) {
            var sh2 = mkShot(opts[i].dir, powers[j], 0, 0, spot, pc);
            var sm2 = simulate(state, sh2);
            var sc2 = scoreOutcome(state, sm2, me, L) + (opts[i].clear ? 20 : 0);
            if (sc2 > bsS) { bsS = sc2; bestS = sh2; }
          }
          if (L.spin && !opts[i].clear) {                // 困難電腦：被擋住時會試跳桿飛過去
            var jp = [450, 650, 850];
            for (j = 0; j < jp.length; j++) {
              var sh3 = mkShot(opts[i].dir, jp[j], 0, 0, spot, pc); sh3.jump = 1;
              var sc3 = scoreOutcome(state, simulate(state, sh3), me, L) + 5;
              if (sc3 > bsS) { bsS = sc3; bestS = sh3; }
            }
          }
        }
        var base = bestS || mkShot({ x: 1, y: 0 }, 400, 0, 0, spot, pc);
        var n4 = noisy({ x: base.ax / 1e6, y: base.ay / 1e6 }, base.power);
        shot = mkShot(n4.dir, n4.power, 0, 0, spot, pc); if (base.jump) shot.jump = 1;
      }
    }
    return { shot: shot, think: think };
  }

  return { LEVELS: LEVELS, chooseShot: chooseShot, potCandidates: potCandidates, simulate: simulate };
});
