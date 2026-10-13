'use strict';

const assert = require('assert');
const Status = require('../public/js/game-status.js');

function makeClock() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      tasks.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    runNext() {
      const entry = tasks.entries().next().value;
      assert(entry, '預期有待執行的提示計時器');
      tasks.delete(entry[0]);
      entry[1].fn();
      return entry[1].delay;
    }
  };
}

function verifyGameStatus() {
  const clock = makeClock();
  let view = null;
  const status = Status.create(next => { view = next; }, clock);

  status.update('輪到你出桿', true, '1:aiming');
  status.toast('定桿：母球會停在原地', 'message');
  status.update('球況更新中…', false, '1:strike');
  assert.deepStrictEqual(view, { text: '球況更新中…', mine: false, kind: null }, '出桿開始時應立即解除舊提示，顯示球況處理中');

  status.update('輪到對手出桿', false, '2:waiting');
  status.toast('你進袋 1 號球，輪到你續打', 'message');
  status.update('輪到你出桿', true, '3:aiming');
  assert.deepStrictEqual(view, { text: '輪到你出桿', mine: true, kind: null }, '新回合應立即取代上一桿提示');

  status.toast('操作提示', 'foul');
  status.update('輪到電腦思考中…', false, '3:aiming');
  assert.strictEqual(view.text, '操作提示', '同一球況下提示仍應可見');
  assert.strictEqual(clock.runNext(), 2800, '提示仍保留原本的最長顯示時間');
  assert.deepStrictEqual(view, { text: '輪到電腦思考中…', mine: false, kind: null }, '提示逾時後應恢復最後收到的回合文字');
  console.log('✓ 狀態提示會隨球況更新解除遮擋，逾時則恢復最新回合文字');
}

if (require.main === module) verifyGameStatus();
module.exports = verifyGameStatus;
