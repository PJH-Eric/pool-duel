/* 電腦對手：五個難度（幼幼班／簡單／普通／困難／神話）。與遊戲共用同一套物理與規則（用引擎模擬候選桿）。 */
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
    hard:   { name: '困難',   err: 0.14, perr: 0.01, sims: 9, spin: true,  pos: true,  wild: 0,    nearest: false, search: true, think: [1500, 2500] },
    myth:   { name: '神話', err: 0.025, perr: 0.003, sims: 16, spin: true, pos: true, wild: 0, nearest: false, deep: true, search: true, think: [2000, 3200] }
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
  function aimPoint(p) {
    var P0 = P.POCKETS[p];
    return { x: P0.hx, y: P0.hy };
  }

  // 幾何候選：直接把目標球打進袋
  function potCandidates(state, cue, opts) {
    opts = opts || {};
    var balls = state.balls, out = [];
    var targets = Rules.legalFirstIds(state);
    var needCall = Rules.needCall(state);
    var cx = cue.x, cy = cue.y;
    for (var ti = 0; ti < targets.length; ti++) {
      var T = Rules.getBall(state, targets[ti]);
      if (!T || T.pocket >= 0) continue;
      // 九球/八球：8 號球在未輪到時不當作目標（legalFirstIds 已處理）
      for (var p = 0; p < 6; p++) {
        var ap = aimPoint(p);
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
        var ap = aimPoint(p), tx = ap.x - T.x, ty = ap.y - T.y, d = Math.sqrt(tx * tx + ty * ty);
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

  // 角度掃描：每隔幾度、多種力道與擊球點都用引擎預演，挑分數最高的（會自己找出組合球、反彈球、解球與安全球）
  function searchBest(state, spot, L, me, callArg, rng) {
    var cue = spot || state.balls[0], best = null, bs = -1e12, a, k, m, pots = [];
    var step = L.deep ? 3 : 5, powers = L.deep ? [220, 380, 560, 760, 980] : [380, 650, 950], spins = L.deep ? [0, 300, -300] : [0];
    var off = rng ? rng.next() * step : 0;
    function tryShot(deg, pw, sy, jump) {
      var ar = deg * Math.PI / 180, sh = mkShot({ x: Math.cos(ar), y: Math.sin(ar) }, pw, 0, sy, spot, callArg);
      if (jump) sh.jump = 1;
      var sc = scoreOutcome(state, simulate(state, sh), me, L);
      if (sc >= 40) pots.push({ deg: deg, pw: pw, sy: sy, jump: jump, sc: sc });
      if (sc > bs) { bs = sc; best = { deg: deg, pw: pw, sy: sy, jump: jump }; }
    }
    for (a = off; a < 360; a += step) for (k = 0; k < powers.length; k++) for (m = 0; m < spins.length; m++) tryShot(a, powers[k], spins[m], false);
    if (best) {                                     // 在最好的角度附近再細掃
      var b0 = best, fine = L.deep ? [-1.5, -1, -0.5, 0.5, 1, 1.5] : [-1.5, -0.75, 0.75, 1.5];
      for (k = 0; k < fine.length; k++) tryShot(b0.deg + fine[k], b0.pw, b0.sy, false);
      var pj = [b0.pw * 0.8, b0.pw, Math.min(1000, b0.pw * 1.2)];
      for (k = 0; k < pj.length; k++) tryShot(best.deg, pj[k], best.sy, false);
    }
    if (!best) return null;
    if (pots.length) {                               // 進球的打法要經得起一點點誤差，不然是運氣
      pots.sort(function (x, y) { return y.sc - x.sc; });
      var tt = [[-0.35, 1], [0.35, 1], [0, 0.95], [0, 1.05], [-0.18, 1], [0.18, 1]], bt2 = -1e12;
      for (k = 0; k < Math.min(10, pots.length); k++) {
        var pk = pots[k], okn = 0;
        for (m = 0; m < tt.length; m++) {
          var a3 = (pk.deg + tt[m][0]) * Math.PI / 180, sh5 = mkShot({ x: Math.cos(a3), y: Math.sin(a3) }, Math.min(1000, pk.pw * tt[m][1]), 0, pk.sy, spot, callArg);
          var r5 = simulate(state, sh5); if (r5.info.pocketedObjects.length && !r5.info.fouls.length) okn++;
        }
        var tot2 = pk.sc - 140 * (1 - okn / tt.length);
        if (tot2 > bt2) { bt2 = tot2; best = pk; bs = tot2; }
      }
    }
    var ar2 = best.deg * Math.PI / 180, out = mkShot({ x: Math.cos(ar2), y: Math.sin(ar2) }, best.pw, 0, best.sy, spot, callArg);
    if (best.jump) out.jump = 1;
    return { shot: out, sc: bs, dir: { x: Math.cos(ar2), y: Math.sin(ar2) } };
  }

  function chooseShot(state, level, rng) {
    var L = LEVELS[level] || LEVELS.normal, me = state.turn, i, j;
    var cue = state.balls[0], spot = null;
    if (state.hand) { spot = pickPlacement(state, L, rng); cue = { x: spot.x, y: spot.y }; }
    var think = Math.round(L.think[0] + rng.next() * (L.think[1] - L.think[0]));
    var callMode = Rules.needCall(state) ? 'eight' : (Rules.needCallBall(state) ? 'ball' : null);
    function cl(pocket, id) { return callMode === 'eight' ? pocket : (callMode === 'ball' ? { pocket: pocket, cb: id } : null); }
    function cl2(st, cand) { return Rules.needCall(st) ? cand.pocket : (Rules.needCallBall(st) ? { pocket: cand.pocket, cb: cand.target } : null); }
    function isLegalNormalSafety(safetyShot) {
      return level !== 'normal' || callMode !== 'ball' || !simulate(state, safetyShot).info.fouls.length;
    }
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
        var best = null, bs = -1e12, pool2 = [];
        var K = Math.min(L.sims, cands.length);
        for (i = 0; i < K; i++) {
          var c = cands[i];
          var variants = [[1.05, 0, 0]];
          if (L.spin) variants = [[1.05, 0, 0], [1.3, 0, 0], [1.1, 0, 330], [1.1, 0, -330], [0.9, 0, 0]];
          if (L.deep) variants = [[1.0, 0, 0], [1.1, 0, 0], [1.3, 0, 0], [1.6, 0, 0], [0.9, 0, 0], [1.1, 0, 330], [1.3, 0, 330], [1.1, 0, -330], [1.3, 0, -330], [1.1, 0, 480], [1.1, 0, -480], [1.2, 0, 40]];
          for (j = 0; j < variants.length; j++) {
            var v = variants[j];
            var sh = mkShot(c.dir, Math.min(1000, powerFor(c, v[0])), v[1], v[2], spot, cl(c.pocket, c.target));
            var sm = simulate(state, sh);
            var sco = scoreOutcome(state, sm, me, L) - c.diff * 4;
            if (L.search) pool2.push({ c: c, v: v, sh: sh, sm: sm, sco: sco });
            if (sco > bs) { bs = sco; best = { c: c, v: v, sh: sh }; }
          }
        }
        if (bs < 40 && L.search) {                    // 沒有任何候選進得了：把角度微調掃一輪（補幾何估算的小誤差）
          var offs = L.deep ? [-0.9, -0.6, -0.3, 0.3, 0.6, 0.9] : [-0.6, -0.3, 0.3, 0.6];
          for (i = 0; i < Math.min(8, cands.length); i++) {
            for (var oi = 0; oi < offs.length; oi++) {
              var dR = rotate(cands[i].dir, offs[oi]);
              [1.05, 1.3].forEach(function (pm) {
                var shR = mkShot(dR, Math.min(1000, powerFor(cands[i], pm)), 0, 0, spot, cl(cands[i].pocket, cands[i].target));
                var scR = scoreOutcome(state, simulate(state, shR), me, L) - cands[i].diff * 4;
                if (scR > bs) { bs = scR; best = { c: Object.assign({}, cands[i], { dir: dR }), v: [pm, 0, 0], sh: shR }; }
              });
            }
          }
        }
        if (L.search && bs >= 40 && pool2.length) {   // 穩定度：把前幾名的進球打法加一點角度與力道誤差再預演，挑「差一點點也進」的
          pool2.sort(function (x, y) { return y.sco - x.sco; });
          var tests = [[-0.35, 1], [0.35, 1], [0, 0.95], [0, 1.05], [-0.18, 1], [0.18, 1], [-0.18, 0.97], [0.18, 1.03]];
          var topR = pool2.slice(0, 16), bestR = -1e12;
          for (i = 0; i < topR.length; i++) {
            var tr = topR[i]; if (tr.sco < 40) continue;
            var okc = 0;
            for (j = 0; j < tests.length; j++) {
              var shT = mkShot(rotate(tr.c.dir, tests[j][0]), Math.min(1000, tr.sh.power * tests[j][1]), tr.sh.sx, tr.sh.sy, spot, cl(tr.c.pocket, tr.c.target));
              var rT = simulate(state, shT);
              if (rT.info.pocketedObjects.length && !rT.info.fouls.length) okc++;
            }
            tr.sco += 160 * okc / tests.length;
            if (tr.sco > bestR) { bestR = tr.sco; best = { c: tr.c, v: tr.v, sh: tr.sh }; }
          }
        }
        var searchPick = null;
        var needsSafetyRescue = level === 'normal' && callMode === 'ball' && bs < -200;
        if ((bs < 40 && L.search && callMode !== 'eight') || needsSafetyRescue) {
          var sr = searchBest(simState, spot, L, me, callMode === 'ball' ? { safety: 1 } : null, rng);
          if (sr && sr.sc > bs + 10 && isLegalNormalSafety(sr.shot)) searchPick = sr;
        }
        if (L.deep && !searchPick && pool2.length) {                 // 神話：把前幾名的打法再往後預演一桿（打進後下一桿好不好打）
          pool2.sort(function (x, y) { return y.sco - x.sco; });
          var top = pool2.slice(0, 5), bt = -1e12;
          for (i = 0; i < top.length; i++) {
            var tp = top[i], ns2 = tp.sm.info.state, total = tp.sco;
            if (ns2.turn === me && ns2.phase === 'play' && !ns2.hand && !tp.sm.info.fouls.length) {
              var nc = potCandidates(ns2, ns2.balls[0]), nb = -1e12;
              for (j = 0; j < Math.min(3, nc.length); j++) {
                var sh4 = mkShot(nc[j].dir, Math.min(1000, powerFor(nc[j], 1.1)), 0, 0, null, cl2(ns2, nc[j]));
                var v4 = scoreOutcome(ns2, simulate(ns2, sh4), me, L) - nc[j].diff * 4;
                if (v4 > nb) nb = v4;
              }
              total += 0.55 * (nb > -1e11 ? nb : -150);
            }
            if (total > bt) { bt = total; best = { c: tp.c, v: tp.v, sh: tp.sh }; }
          }
        }
        // 輸入誤差在決定之後才加（讓高難度偶有失誤、但不離譜）
        if (searchPick) {
          if (level === 'normal' && callMode === 'ball') shot = searchPick.shot;
          else {
            var nS = noisy(searchPick.dir, searchPick.shot.power);
            shot = mkShot(nS.dir, nS.power, searchPick.shot.sx, searchPick.shot.sy, spot, callMode === 'ball' ? { safety: 1 } : null);
          }
        } else {
          var n2 = noisy(best.c.dir, best.sh.power);
          shot = mkShot(n2.dir, n2.power, best.sh.sx, best.sh.sy, spot, cl(best.c.pocket, best.c.target));
        }
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
        var needsSafetySearch = level === 'normal' && callMode === 'ball' && bsS < -200;
        if (L.search || needsSafetySearch) { // 14-1 沒有合法直線安全球時掃描角度，避免連續漏碰／犯規
          var sr2 = searchBest(simState, spot, L, me, pc, rng);
          if (sr2 && sr2.sc > bsS && isLegalNormalSafety(sr2.shot)) base = sr2.shot;
        }
        if (level === 'normal' && callMode === 'ball' && base.safety === 1) shot = base;
        else {
          var n4 = noisy({ x: base.ax / 1e6, y: base.ay / 1e6 }, base.power);
          shot = mkShot(n4.dir, n4.power, base.sx || 0, base.sy || 0, spot, pc); if (base.jump) shot.jump = 1;
        }
      }
    }
    return { shot: shot, think: think };
  }

  return { LEVELS: LEVELS, chooseShot: chooseShot, potCandidates: potCandidates, simulate: simulate };
});
