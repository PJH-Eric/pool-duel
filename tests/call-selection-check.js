'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../public/js/physics-config.js');
const P = require('../public/js/physics.js');
const Rules = require('../public/js/rules.js');
const Turn = require('../public/js/turn-config.js');
const gameSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game.js'), 'utf8');

function createGame() {
  const browser = {
    PoolConfig: C,
    PoolPhysics: P,
    PoolRules: Rules,
    PoolAI: {},
    RNG: {},
    PoolRender: {},
    PoolTurn: Turn,
    Sound: { unlock() {}, sfx: { click() {} } }
  };
  vm.runInNewContext(gameSource, { self: browser }, { filename: 'public/js/game.js' });

  const handlers = {};
  const canvas = {
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, callback) { handlers[name] = callback; },
    getBoundingClientRect() { return { left: 0, top: 0 }; }
  };
  const game = Object.create(browser.PoolGame.prototype);
  Object.assign(game, {
    canvas,
    phase: 'aiming',
    state: { kind: 'score', kids: false, isBreak: false, phase: 'play' },
    call: -1,
    callBall: -1,
    safety: false,
    dragMode: null,
    hand: null,
    r: { toTable: () => ({ x: 250, y: 250 }), pocketHit: () => 5 },
    pushControls() {},
    refresh() {}
  });
  game._bindPointer();
  return { game, handlers };
}

function click(game, handlers) {
  handlers.pointerdown({ clientX: 10, clientY: 10, pointerId: 1, preventDefault() {} });
}

function verifyCallSelection() {
  const { game, handlers } = createGame();
  game.ballHit = () => 7;
  click(game, handlers);
  assert.equal(game.callBall, 7, 'ball hit must win when a ball and pocket overlap');
  assert.equal(game.call, -1, 'the pocket must remain unselected until the ball is chosen');

  const emptyClick = createGame();
  emptyClick.game.ballHit = () => -1;
  click(emptyClick.game, emptyClick.handlers);
  assert.equal(emptyClick.game.call, -1, 'a pocket cannot be called before a ball is selected');
  assert.equal(emptyClick.game.dragMode, null, 'clicking a disabled pocket must not start aiming');

  click(game, handlers);
  assert.equal(game.call, 5, 'the pocket can be called after selecting a ball');
  console.log('✓ 14-1 叫球時，重疊的球優先選取，之後才能選袋口');
}

if (require.main === module) verifyCallSelection();
module.exports = verifyCallSelection;
