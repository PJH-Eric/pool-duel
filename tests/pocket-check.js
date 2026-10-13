'use strict';
const assert = require('node:assert/strict');
const P = require('../public/js/physics.js');
const C = P.C;
let checked = 0;

function shot(x, y, vx, vy, scale) {
  const world = P.makeWorld([{ id: 1, x, y }], { pocketScale: scale });
  world.balls[0].vx = vx; world.balls[0].vy = vy;
  P.runToRest(world);
  for (const event of world.events.filter(e => e.type === 'pocket')) {
    const pocket = P.POCKETS[event.pocket];
    const distance = Math.hypot(event.x - pocket.hx, event.y - pocket.hy);
    const allowedOverlap = pocket.corner ? C.CORNER_CAPTURE_EASE : C.R * C.SIDE_CAPTURE_EASE_RATIO;
    assert.ok(distance + C.R <= pocket.hr * scale + allowedOverlap + 0.01,
      `提前進袋：袋 ${event.pocket}，球心距離 ${distance.toFixed(2)} + 球半徑 ${C.R} 超過容許袋緣 ${allowedOverlap.toFixed(2)}`);
  }
  assert.ok(!P.collect(world).timedOut, '袋口附近的擊球必須能停止');
  const edge = Math.max(C.HOLE_OFF_CORNER + C.HOLE_R_CORNER * scale, C.HOLE_OFF_SIDE + C.HOLE_R_SIDE * scale);
  const ball = world.balls[0];
  assert.ok(ball.pocket >= 0 || (ball.x >= -edge && ball.x <= C.W + edge && ball.y >= -edge && ball.y <= C.H + edge),
    '擦過袋口的球必須由導槽邊界擋回，不能飛出木框');
  checked++;
  return world;
}

// 中袋與角袋只放寬極小比例，不能明顯跨過可見袋緣。
for (const scale of [1, C.POCKET_SCALE_BIG]) {
  for (const pocket of P.POCKETS) {
    const fullBallRadius = pocket.hr * scale - C.R;
    const captureRadius = P.capRadius(pocket, scale);
    if (pocket.corner) {
      assert.equal(captureRadius, fullBallRadius + C.CORNER_CAPTURE_EASE, '角袋只容許半個物理單位的判定補償');
    } else {
      const easedRadius = C.R * 0.02;
      assert.ok(captureRadius > fullBallRadius && captureRadius <= fullBallRadius + easedRadius + 0.001,
        '中袋只容許很小的球體比例跨過袋緣');
    }
  }
}

// 角袋補償只跨過原門檻一點點，超過補償上限仍不可進袋。
for (const pocket of P.POCKETS.filter(p => p.corner)) {
  const inwardX = pocket.x ? -Math.SQRT1_2 : Math.SQRT1_2;
  const inwardY = pocket.y ? -Math.SQRT1_2 : Math.SQRT1_2;
  for (const [offset, expectedPocket] of [[-0.25, pocket], [0.25, null]]) {
    const distance = P.capRadius(pocket, 1) + offset;
    const world = P.makeWorld([{
      id: 1,
      x: pocket.hx + inwardX * distance,
      y: pocket.hy + inwardY * distance
    }]);
    P.stepWorld(world);
    const expectedIndex = expectedPocket ? P.POCKETS.indexOf(expectedPocket) : -1;
    const message = expectedPocket ? '角袋微量補償範圍內應進袋' : '超過角袋微量補償範圍仍不可進袋';
    assert.equal(world.balls[0].pocket, expectedIndex, message);
    checked++;
  }
}

// 角袋袋口與袋口碰撞點共用較窄的缺口，畫面與實際入口不可分離。
assert.ok(C.CORNER_GAP < 34 && C.CORNER_GAP >= 33, '角袋入口只比原本略窄');
for (const pocket of P.POCKETS.filter(p => p.corner)) {
  const mouth = P.pocketGeometry(pocket, 1).mouth;
  const width = Math.hypot(mouth[0].x - mouth[1].x, mouth[0].y - mouth[1].y);
  assert.ok(Math.abs(width - C.CORNER_GAP * Math.SQRT2) < 0.001,
    '角袋碰撞幾何應使用同一個較窄入口');
}

// 球體仍跨在洞緣上時不能直接消失；球的半徑必須納入判定。
for (const scale of [1, C.POCKET_SCALE_BIG]) {
  for (const pocket of P.POCKETS) {
    const ux = pocket.corner ? (pocket.x ? -Math.SQRT1_2 : Math.SQRT1_2) : 0;
    const uy = (pocket.y ? -1 : 1) * (pocket.corner ? Math.SQRT1_2 : 1);
    const distance = pocket.hr * scale - 0.5;
    const world = P.makeWorld([{ id: 1, x: pocket.hx + ux * distance, y: pocket.hy + uy * distance }], { pocketScale: scale });
    P.stepWorld(world);
    assert.equal(world.balls[0].pocket, -1, '球尚未完整進入圓形袋口時不能判進袋');
    checked++;
  }
}

// 原始重現：左上角斜擦導槽，在可見袋口外被邊界保護程式當成進袋。
const angle = 145 * Math.PI / 180;
shot(16, 16, Math.cos(angle) * 900, Math.sin(angle) * 900, 1);

// 單球慢速斜向進底袋後，球心停在黑洞視覺範圍內，卻未被判進袋。
const bottomPocketAngle = 50 * Math.PI / 180;
for (const right of [false, true]) for (const bottom of [false, true]) {
  const pocketIndex = (bottom ? 3 : 0) + (right ? 2 : 0);
  const world = P.makeWorld([{ id: 2, x: right ? C.W - 20 : 20, y: bottom ? C.H - 34 : 34 }]);
  world.balls[0].vx = (right ? 1 : -1) * Math.cos(bottomPocketAngle) * 180;
  world.balls[0].vy = (bottom ? 1 : -1) * Math.sin(bottomPocketAngle) * 180;
  P.runToRest(world);
  assert.equal(world.balls[0].pocket, pocketIndex, '單球慢速斜向進底袋應確實進袋');
  checked++;
}

// 已深入袋內而失去支撐的球會滑落；仍在袋緣上的球必須留在原處。
for (const pocket of P.POCKETS.filter(p => p.corner)) {
  const ux = pocket.x ? -Math.SQRT1_2 : Math.SQRT1_2;
  const uy = pocket.y ? -Math.SQRT1_2 : Math.SQRT1_2;
  for (const scale of [1, C.POCKET_SCALE_BIG]) {
    const supportRadius = pocket.hr * scale - C.R / 2;
    const inside = shot(pocket.hx + ux * (supportRadius - 0.25), pocket.hy + uy * (supportRadius - 0.25), 0, 0, scale);
    assert.equal(inside.balls[0].pocket, P.POCKETS.indexOf(pocket), '深入角袋後不能懸停在袋內');
    const x = pocket.hx + ux * (supportRadius + 0.25), y = pocket.hy + uy * (supportRadius + 0.25);
    const edge = shot(x, y, 0, 0, scale);
    assert.equal(edge.balls[0].pocket, -1, '袋緣有支撐的球不能被吸入角袋');
    assert.ok(Math.hypot(edge.balls[0].x - x, edge.balls[0].y - y) < 0.001, '袋緣靜止球不能被移動');
  }
}

// 高速斜擦小範圍時，單一步的兩端都可能在洞外；仍須偵測實際通過洞內的路徑。
for (const index of [1, 4]) {
  const pocket = P.POCKETS[index];
  const world = P.makeWorld([{ id: 1, x: pocket.hx - 3.1, y: pocket.hy + (pocket.y ? -1 : 1) * (pocket.hr - C.R - 0.01) }]);
  world.balls[0].vx = 3300;
  P.stepWorld(world);
  assert.equal(world.balls[0].pocket, index, '高速球穿過洞內不能漏判');
  checked++;
}

for (const scale of [1, C.POCKET_SCALE_BIG]) {
  for (const speed of [180, 900, 3300]) {
    for (let index = 0; index < P.POCKETS.length; index++) {
      const pocket = P.POCKETS[index];
      const ux = pocket.corner ? (pocket.x ? -Math.SQRT1_2 : Math.SQRT1_2) : 0;
      const uy = (pocket.y ? -1 : 1) * (pocket.corner ? Math.SQRT1_2 : 1);
      const world = shot(pocket.hx + ux * 60, pocket.hy + uy * 60, -ux * speed, -uy * speed, scale);
      assert.equal(world.balls[0].pocket, index, '六袋正向入袋在慢速、快速與加大袋口都應成立');
    }
    for (const x of [16, 34, 60]) for (const y of [16, 34, 60]) {
      for (let degrees = 0; degrees < 360; degrees += 10) {
        const radians = degrees * Math.PI / 180;
        for (const right of [false, true]) for (const bottom of [false, true]) {
          shot(right ? C.W - x : x, bottom ? C.H - y : y,
            Math.cos(radians) * speed * (right ? -1 : 1), Math.sin(radians) * speed * (bottom ? -1 : 1), scale);
        }
      }
    }
    for (const offset of [-30, 0, 30]) for (const bottom of [false, true]) {
      for (let degrees = 0; degrees < 360; degrees += 10) {
        const radians = degrees * Math.PI / 180;
        shot(C.W / 2 + offset, bottom ? C.H - 16 : 16,
          Math.cos(radians) * speed, Math.sin(radians) * speed * (bottom ? -1 : 1), scale);
      }
    }
  }
}
console.log(`進袋回歸檢查：${checked} 個情境通過`);
