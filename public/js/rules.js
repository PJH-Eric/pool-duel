/* 規則核心：九球 / 八號球（正式）/ 14-1 連續進球（內部代號 score）。單機、線上伺服器、電腦模擬共用。
   純資料進、純資料出：state 是可 JSON 序列化的物件。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./physics.js'));
  else root.PoolRules = factory(root.PoolPhysics);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';
  var C = P.C, R = C.R, W = C.W, H = C.H;
  var FOUL_TEXT = {
    scratch: '母球落袋', nocontact: '沒有碰到任何球', wrongfirst: '先碰到不該碰的球',
    norail: '碰球後沒有球進袋、也沒有球碰庫', timeout: '回合超時', breakfail: '開球沒有達標', nocall: '沒有叫球'
  };
  var KIND_NAME = { nine: '簡化九球', eight: '八號球', score: '14-1 連續進球' };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function other(p) { return 1 - p; }
  function groupOf(id) { return id >= 1 && id <= 7 ? 'solid' : (id >= 9 && id <= 15 ? 'stripe' : null); }
  function getBall(s, id) { for (var i = 0; i < s.balls.length; i++) if (s.balls[i].id === id) return s.balls[i]; return null; }
  function onTable(s) { return s.balls.filter(function (b) { return b.pocket < 0 && b.id > 0; }); }
  function ownLeft(s, player) {
    var g = s.groups[player]; if (!g) return -1;
    return onTable(s).filter(function (b) { return groupOf(b.id) === g; }).length;
  }

  // ---------- 開新局 ----------
  function newGame(kind, opts, rng) {
    opts = opts || {};
    var balls = [{ id: 0, x: C.HEAD_X, y: C.CENTER_Y, pocket: -1 }].concat(P.rack(kind, rng));
    var breaker = opts.breaker === 1 ? 1 : 0;
    return {
      kind: kind, balls: balls, turn: breaker, breaker: breaker, phase: 'play',
      isBreak: true, hand: { player: breaker, behindHead: true },
      groups: [null, null], scores: [0, 0], target: [15, 30, 60].indexOf(opts.target) >= 0 ? opts.target : 30, pending: null, winner: null, reason: '',
      kids: !!opts.kids, bigPockets: !!opts.bigPockets, shotNo: 0, rackNo: 1, last: null
    };
  }

  function findFreeSpot(balls, x, y, ignoreId) {
    for (var s = 0; s < 14; s++) {
      for (var sign = 1; sign >= -1; sign -= 2) {
        if (s === 0 && sign === -1) continue;
        var px = x + sign * s * (2 * R + 1);
        if (px < R || px > W - R) continue;
        var ok = true;
        for (var i = 0; i < balls.length; i++) {
          var b = balls[i]; if (b.pocket >= 0 || b.id === ignoreId) continue;
          var dx = b.x - px, dy = b.y - y;
          if (dx * dx + dy * dy < (2 * R + 0.5) * (2 * R + 0.5)) { ok = false; break; }
        }
        if (ok) return { x: px, y: y };
      }
    }
    return { x: x, y: y };
  }

  // ---------- 輔助：目標球與指定袋口 ----------
  function legalFirstIds(s) {
    var t = onTable(s), ids = [], i;
    if (s.kind === 'nine') {
      var m = 99; for (i = 0; i < t.length; i++) if (t[i].id < m) m = t[i].id;
      return t.length ? [m] : [];
    }
    if (s.kind === 'score') return t.map(function (b) { return b.id; });
    var g = s.groups[s.turn];
    if (!g) return t.filter(function (b) { return b.id !== 8; }).map(function (b) { return b.id; });
    var own = t.filter(function (b) { return groupOf(b.id) === g; }).map(function (b) { return b.id; });
    if (own.length) return own;
    return t.some(function (b) { return b.id === 8; }) ? [8] : [];
  }
  function needCall(s) {
    return s.kind === 'eight' && !s.isBreak && s.phase === 'play' && s.groups[s.turn] != null &&
      ownLeft(s, s.turn) === 0 && !!getBall(s, 8) && getBall(s, 8).pocket < 0;
  }

  // 14-1：非開球、非幼幼班的每一桿都要「叫球」（點球＋點袋口），或宣告安全球
  function needCallBall(s) {
    return s.kind === 'score' && !s.kids && !s.isBreak && s.phase === 'play';
  }
  // 14-1 重新排球：14 顆已進袋的球重排成三角形（頂點空著），剩下的 1 顆留在原處
  function rerack14(s) {
    var left = onTable(s);
    if (left.length > 1) return false;
    var slots = (function () {
      var out = [], dxr = Math.sqrt(3) * R + 0.05, dy = 2 * R + 0.05, widths = [1, 2, 3, 4, 5];
      for (var r = 0; r < 5; r++) for (var k = 0; k < widths[r]; k++) out.push({ x: C.FOOT_X + r * dxr, y: C.CENTER_Y + (k - (widths[r] - 1) / 2) * dy });
      return out;
    })();
    var keep = left[0] || null, cue = s.balls[0];
    var skipApex = !!keep;
    var use = skipApex ? slots.slice(1) : slots;
    var near = function (b, sl) { var dx = b.x - sl.x, dy = b.y - sl.y; return dx * dx + dy * dy < (2 * R + 1) * (2 * R + 1); };
    if (keep && use.some(function (sl) { return near(keep, sl); })) { keep.x = C.FOOT_X; keep.y = C.CENTER_Y; }
    var ids = s.balls.filter(function (b) { return b.id > 0 && (!keep || b.id !== keep.id); }).map(function (b) { return b.id; });
    ids.forEach(function (id, i) { var b = getBall(s, id); b.x = use[i].x; b.y = use[i].y; b.pocket = -1; });
    if (cue.pocket < 0 && use.some(function (sl) { return near(cue, sl); })) {
      var sp = nearestValidCue({ balls: s.balls, hand: { behindHead: true }, bigPockets: s.bigPockets }, C.HEAD_X, C.CENTER_Y);
      cue.x = sp.x; cue.y = sp.y;
    }
    s.rackNo++;
    return true;
  }

  // ---------- 母球擺放 ----------
  function validCuePlacement(s, x, y) {
    if (!(x >= R && x <= W - R && y >= R && y <= H - R)) return false;
    if (s.hand && s.hand.behindHead && x > C.HEAD_X) return false;
    var scale = s.bigPockets ? C.POCKET_SCALE_BIG : 1, i;
    for (i = 0; i < s.balls.length; i++) {
      var b = s.balls[i]; if (b.id === 0 || b.pocket >= 0) continue;
      var dx = b.x - x, dy = b.y - y;
      if (dx * dx + dy * dy < (2 * R + 0.5) * (2 * R + 0.5)) return false;
    }
    for (i = 0; i < 6; i++) {
      var p = P.POCKETS[i], d = Math.sqrt((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y));
      if (d < P.capRadius(p, scale) + R * 0.6) return false;
    }
    for (i = 0; i < P.JAWS.length; i++) {
      var jx = P.JAWS[i][0] - x, jy = P.JAWS[i][1] - y;
      if (jx * jx + jy * jy < (R + C.JAW_R + 1) * (R + C.JAW_R + 1)) return false;
    }
    return true;
  }
  function nearestValidCue(s, x, y) {
    if (validCuePlacement(s, x, y)) return { x: x, y: y };
    var best = null, bd = 1e12;
    for (var r = 3; r < 260; r += 3) {
      for (var a = 0; a < 24; a++) {
        var ang = a / 24 * 6.283185307179586;
        var cx = x + r * Math.cos(ang), cy = y + r * Math.sin(ang);
        if (validCuePlacement(s, cx, cy)) { var d = r; if (d < bd) { bd = d; best = { x: cx, y: cy }; } }
      }
      if (best) return best;
    }
    return { x: C.HEAD_X, y: C.CENTER_Y };
  }

  // ---------- 出桿驗證 ----------
  function validateShot(s, shot) {
    if (s.phase !== 'play' || s.winner != null) return '現在不能出桿';
    if (!shot || !isFinite(shot.ax) || !isFinite(shot.ay)) return '出桿資料不正確';
    if (Math.abs(shot.ax) > 1000001 || Math.abs(shot.ay) > 1000001 || shot.ax !== Math.round(shot.ax) || shot.ay !== Math.round(shot.ay)) return '出桿資料不正確';
    if (!(shot.power >= 0 && shot.power <= 1000)) return '力度不正確';
    if (shot.power < 5) return '力度太小';
    if (shot.jump != null && shot.jump !== 0 && shot.jump !== 1) return '出桿資料不正確';
    var lim = C.SPIN_MAX * 1000 + 1;
    if (Math.abs(shot.sx || 0) > lim || Math.abs(shot.sy || 0) > lim) return '擊球點不正確';
    if (s.hand) {
      if (!shot.cue || !validCuePlacement(s, shot.cue.x, shot.cue.y)) return '母球位置不合法';
    }
    if (needCall(s)) {
      if (!(shot.call >= 0 && shot.call <= 5 && shot.call === Math.round(shot.call))) return '請先指定 8 號球的袋口';
    }
    if (needCallBall(s) && shot.safety !== 1) {
      var cb = getBall(s, shot.cb);
      if (!cb || cb.pocket >= 0 || cb.id < 1) return '請先點選要打的球';
      if (!(shot.call >= 0 && shot.call <= 5 && shot.call === Math.round(shot.call))) return '請再點選這顆球要進的袋口';
    }
    return null;
  }

  // 把出桿套到 state 上、回傳可直接模擬的 world（含母球擺放）
  function prepareWorld(s, shot) {
    var balls = clone(s.balls);
    if (s.hand && shot.cue) { var c = balls[0]; c.x = shot.cue.x; c.y = shot.cue.y; c.pocket = -1; }
    var w = P.makeWorld(balls.map(function (b) { return { id: b.id, x: b.x, y: b.y, pocket: b.pocket }; }), { pocketScale: s.bigPockets ? C.POCKET_SCALE_BIG : 1 });
    if (s.isBreak) w.speedBoost = C.BREAK_BOOST;
    return w;
  }

  // ---------- 判定一桿 ----------
  function evaluateShot(s0, shot, res) {
    var s = clone(s0), me = s.turn, opp = other(me), i, b;
    var info = { fouls: [], pocketedObjects: [], continued: false, notes: [], pending: null, scratch: false, player: me };
    // 套用位置
    if (s.hand && shot.cue) { s.balls[0].x = shot.cue.x; s.balls[0].y = shot.cue.y; }
    for (i = 0; i < res.balls.length; i++) { b = getBall(s, res.balls[i].id); b.x = res.balls[i].x; b.y = res.balls[i].y; b.pocket = res.balls[i].pocket; }
    s.hand = null;
    s.shotNo++;
    var wasBreak = s.isBreak;
    var pocketedObj = res.pocketed.filter(function (p) { return p.id > 0; }).map(function (p) { return p.id; });
    info.pocketedObjects = pocketedObj.slice();
    var scratch = res.cueScratch;
    info.scratch = scratch;

    // 犯規
    var fouls = [];
    if (!s.kids) {
      if (scratch) fouls.push('scratch');
      if (res.firstContact < 0) fouls.push('nocontact');
      else {
        var legal = legalFirstIds(s0);
        if (legal.indexOf(res.firstContact) < 0) fouls.push('wrongfirst');
      }
      if (res.firstContact >= 0 && pocketedObj.length === 0 && !res.railAfterContact && !scratch) fouls.push('norail');
    }
    var foul = fouls.length > 0;

    function finish(winner, reason) { s.winner = winner; s.reason = reason; s.phase = 'over'; }
    function cueToHand(player, behindHead) {
      var c = s.balls[0]; c.pocket = -1;
      var spot = nearestValidCue({ balls: s.balls, hand: { behindHead: !!behindHead }, bigPockets: s.bigPockets }, scratch ? C.HEAD_X : c.x, scratch ? C.CENTER_Y : c.y);
      c.x = spot.x; c.y = spot.y;
      s.hand = { player: player, behindHead: !!behindHead };
    }
    function respot(id) {
      var bb = getBall(s, id), sp = findFreeSpot(s.balls, C.FOOT_X, C.CENTER_Y, id);
      bb.x = sp.x; bb.y = sp.y; bb.pocket = -1;
    }

    // ===== 九球 =====
    if (s.kind === 'nine') {
      var nine = pocketedObj.indexOf(9) >= 0;
      if (nine && !foul) { finish(me, 'nine'); info.fouls = []; }
      else {
        if (nine) respot(9);
        info.continued = !foul && pocketedObj.length > 0;
      }
    }
    // ===== 14-1 連續進球 =====
    else if (s.kind === 'score') {
      var called = needCallBall(s0) && shot.safety !== 1;
      var safety = needCallBall(s0) && shot.safety === 1;
      var made = false, pts = 0;
      if (s.kids) {
        pts = pocketedObj.length; s.scores[me] += pts;
        info.continued = pts > 0;
      } else if (foul) {
        // 犯規：扣 1 分，這桿進袋的球全部歸位、不計分
        pocketedObj.forEach(respot);
        s.scores[me] -= 1; info.penalty = 1;
      } else if (safety) {
        pocketedObj.forEach(respot);
        info.safety = true;
      } else {
        if (called) {
          made = res.pocketed.some(function (p) { return p.id === shot.cb && p.pocket === shot.call; });
          info.called = { ball: shot.cb, pocket: shot.call };
        } else made = pocketedObj.length > 0;    // 開球：進幾顆算幾分
        if (made) { pts = pocketedObj.length; s.scores[me] += pts; info.continued = true; }
        else pocketedObj.forEach(respot);          // 叫的球沒進指定袋口：其他進袋的球歸位、不計分
        info.missedCall = called && !made;
      }
      info.made = made; info.pts = pts;
      if (s.scores[me] >= s.target) finish(me, 'score');
      else if (onTable(s).length <= 1 && rerack14(s)) info.reracked = true;
    }
    // ===== 八號球 =====
    else {
      var eight = pocketedObj.indexOf(8) >= 0;
      if (wasBreak) {
        var breakRails = res.railBalls.filter(function (id) { return id > 0; }).length;
        if (eight) {
          s.balls[0].pocket = -1;
          if (scratch) { info.pending = { type: 'eight-break-scratch', player: opp, options: ['rerack', 'respot'] }; }
          else { info.pending = { type: 'eight-break', player: me, options: ['rerack', 'respot'] }; }
          info.fouls = scratch ? ['scratch'] : [];
        } else if (!foul && pocketedObj.length === 0 && breakRails < 4) {
          info.pending = { type: 'break-fail', player: opp, options: ['accept', 'rerack'] };
          fouls = ['breakfail']; foul = true;
        } else {
          info.continued = !foul && pocketedObj.length > 0;
        }
        s.isBreak = false;
      } else {
        var g = s.groups[me];
        if (eight) {
          var legalWin = !foul && g != null && ownLeft(s, me) === 0 && res.pocketed.some(function (p) { return p.id === 8 && (s.kids || p.pocket === shot.call); });
          if (legalWin) finish(me, 'eight');
          else { finish(opp, 'eight-foul'); info.fouls = fouls.slice(); info.eightLoss = !g ? 'open' : (foul ? 'foul' : (ownLeft(s, me) > 0 ? 'early' : 'pocket')); }
        } else {
          if (!foul && !g && pocketedObj.length > 0) {
            var first = pocketedObj[0], gg = groupOf(first);
            s.groups[me] = gg; s.groups[opp] = gg === 'solid' ? 'stripe' : 'solid';
            info.notes.push({ code: 'assign', player: me, group: gg });
            g = gg;
          }
          var ownPocketed = g ? pocketedObj.filter(function (id) { return groupOf(id) === g; }).length : 0;
          info.continued = !foul && ownPocketed > 0;
        }
      }
    }

    info.fouls = (s.winner != null && s.reason === 'eight-foul') ? fouls.slice() : (fouls.length ? fouls : info.fouls);
    if (info.pending) {
      s.phase = 'choice'; s.pending = info.pending;
      s.turn = info.pending.player === me && info.pending.type === 'eight-break' ? me : info.pending.player;
      if (scratch) { s.balls[0].pocket = -1; s.balls[0].x = C.HEAD_X; s.balls[0].y = C.CENTER_Y; }
    } else if (s.phase !== 'over') {
      if (foul || scratch) {
        s.turn = opp;
        if (!s.kids || scratch) cueToHand(opp, false);
      } else if (info.continued) {
        s.turn = me;
      } else {
        s.turn = opp;
      }
    }
    if (foul && !s.kids && s.phase === 'play' && !s.hand) cueToHand(opp, false);
    s.isBreak = wasBreak && info.pending ? s.isBreak : false;
    s.last = { player: me, fouls: info.fouls, pocketed: pocketedObj, scratch: scratch, continued: info.continued, eightLoss: info.eightLoss || null, pts: info.pts || 0, safety: !!info.safety, made: !!info.made, penalty: info.penalty || 0, reracked: !!info.reracked, called: info.called || null };
    info.state = s;
    return info;
  }

  // 輪到的人超時 → 犯規換手
  function timeoutFoul(s0) {
    var s = clone(s0), me = s.turn, opp = other(me);
    if (s.phase === 'choice') return resolveChoice(s, defaultChoice(s), null);
    s.shotNo++;
    if (s.kind === 'score' && !s.kids) s.scores[me] -= 1;
    s.turn = opp;
    var wasBreak = s.isBreak;
    if (wasBreak) { s.breaker = opp; s.hand = { player: opp, behindHead: true }; }
    else { s.isBreak = false; s.hand = { player: opp, behindHead: false }; }
    var c = s.balls[0]; c.pocket = -1;
    var spot = nearestValidCue({ balls: s.balls, hand: s.hand, bigPockets: s.bigPockets }, c.x, c.y);
    c.x = spot.x; c.y = spot.y;
    s.last = { player: me, fouls: ['timeout'], pocketed: [], scratch: false, continued: false };
    return { state: s, fouls: ['timeout'], continued: false, pending: null, notes: [], pocketedObjects: [], scratch: false, player: me };
  }

  function defaultChoice(s) {
    if (!s.pending) return null;
    return s.pending.type === 'break-fail' ? 'accept' : 'rerack';
  }

  function rerackState(s, rng) {
    s.balls = [{ id: 0, x: C.HEAD_X, y: C.CENTER_Y, pocket: -1 }].concat(P.rack(s.kind, rng || function () { return 0.5; }));
    s.turn = s.breaker; s.isBreak = true; s.hand = { player: s.breaker, behindHead: true };
    s.groups = [null, null]; s.rackNo++; s.phase = 'play'; s.pending = null;
  }

  function resolveChoice(s0, choice, rng) {
    var s = clone(s0), p = s.pending;
    if (!p || s.phase !== 'choice') return { state: s, error: '目前沒有需要選擇的事項' };
    if (p.options.indexOf(choice) < 0) choice = defaultChoice(s);
    var info = { choice: choice, type: p.type, player: p.player };
    var opp = other(s.breaker);
    if (p.type === 'break-fail') {
      if (choice === 'accept') {
        s.phase = 'play'; s.pending = null; s.isBreak = false; s.turn = p.player;
        s.hand = { player: p.player, behindHead: false };
        var sp = nearestValidCue({ balls: s.balls, hand: s.hand, bigPockets: s.bigPockets }, C.HEAD_X, C.CENTER_Y);
        s.balls[0].x = sp.x; s.balls[0].y = sp.y; s.balls[0].pocket = -1;
      } else rerackState(s, rng);
    } else {
      if (choice === 'rerack') rerackState(s, rng);
      else {
        var e = getBall(s, 8), spot = findFreeSpot(s.balls, C.FOOT_X, C.CENTER_Y, 8);
        e.x = spot.x; e.y = spot.y; e.pocket = -1;
        s.phase = 'play'; s.pending = null; s.isBreak = false;
        if (p.type === 'eight-break') { s.turn = s.breaker; s.hand = null; s.balls[0].pocket = -1; }
        else { s.turn = opp; s.turn = other(s.breaker); s.hand = { player: s.turn, behindHead: false }; s.balls[0].pocket = -1; }
        if (s.hand) { var sp2 = nearestValidCue({ balls: s.balls, hand: s.hand, bigPockets: s.bigPockets }, C.HEAD_X, C.CENTER_Y); s.balls[0].x = sp2.x; s.balls[0].y = sp2.y; }
      }
    }
    info.state = s;
    return info;
  }

  function forfeit(s0, loser, reason) {
    var s = clone(s0); s.winner = other(loser); s.reason = reason || 'forfeit'; s.phase = 'over'; s.pending = null;
    return s;
  }

  // 另一局：換開球者
  function nextGame(prev, rng) {
    return newGame(prev.kind, { breaker: other(prev.breaker), kids: prev.kids, bigPockets: prev.bigPockets, target: prev.target }, rng);
  }

  function describe(info) {
    var out = [];
    (info.fouls || []).forEach(function (f) { out.push(FOUL_TEXT[f] || f); });
    return out;
  }

  return {
    FOUL_TEXT: FOUL_TEXT, KIND_NAME: KIND_NAME, groupOf: groupOf, newGame: newGame, nextGame: nextGame,
    legalFirstIds: legalFirstIds, needCall: needCall, needCallBall: needCallBall, validCuePlacement: validCuePlacement, nearestValidCue: nearestValidCue,
    validateShot: validateShot, prepareWorld: prepareWorld, evaluateShot: evaluateShot, timeoutFoul: timeoutFoul,
    resolveChoice: resolveChoice, defaultChoice: defaultChoice, forfeit: forfeit, onTable: onTable, ownLeft: ownLeft,
    getBall: getBall, describe: describe, clone: clone, findFreeSpot: findFreeSpot
  };
});
