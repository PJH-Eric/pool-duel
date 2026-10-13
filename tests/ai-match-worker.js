'use strict';

const { parentPort, workerData } = require('worker_threads');
const { play } = require('./ai-match');

try {
  parentPort.postMessage({ result: play(workerData.kind, workerData.a, workerData.b, workerData.seed) });
} catch (error) {
  parentPort.postMessage({ error: error.stack || error.message || String(error) });
}
parentPort.close();
