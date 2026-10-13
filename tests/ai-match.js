'use strict';

const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const D = path.join(__dirname, '..', 'public', 'js') + path.sep;
const P = require(D + 'physics.js');
const Rules = require(D + 'rules.js');
const AI = require(D + 'ai.js');
const RNG = require(D + 'rng.js');

function play(kind, a, b, seed) {
  const rng = RNG.create(seed);
  let state = Rules.newGame(kind, {
    breaker: seed % 2,
    kids: a === 'kids' && b === 'kids',
  }, rng);
  let shots = 0;
  const levels = [a, b];

  while (state.phase !== 'over' && shots < 1000) {
    if (state.phase === 'choice') {
      state = Rules.resolveChoice(state, Rules.defaultChoice(state), rng).state;
      continue;
    }

    const { shot } = AI.chooseShot(state, levels[state.turn], rng);
    if (Rules.validateShot(state, shot)) return { err: true };

    const world = Rules.prepareWorld(state, shot);
    P.applyShot(world, shot);
    state = Rules.evaluateShot(state, shot, P.runToRest(world)).state;
    shots++;
  }

  return { s: state, n: shots };
}

function playInWorker(match) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'ai-match-worker.js'), {
      workerData: match,
    });
    let settled = false;

    worker.once('message', message => {
      settled = true;
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    });
    worker.once('error', error => {
      settled = true;
      reject(error);
    });
    worker.once('exit', code => {
      if (!settled) reject(new Error(`AI worker exited without a result (code ${code})`));
    });
  });
}

async function playMatchesParallel(matches, onComplete) {
  const cpuCount = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  const concurrency = Math.max(1, Math.min(matches.length, cpuCount - 2, 6));
  const results = new Array(matches.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < matches.length) {
      const index = nextIndex++;
      results[index] = await playInWorker(matches[index]);
      if (onComplete) onComplete(results[index], matches[index], index);
    }
  }));

  return results;
}

module.exports = { play, playMatchesParallel };
