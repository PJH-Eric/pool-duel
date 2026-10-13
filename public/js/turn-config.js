/* 單機與線上共用的回合計時規則。 */
(function (root) {
  'use strict';
  const config = Object.freeze({ TURN_MS: 35000, EXTENSION_MS: 25000, EXTENSIONS_PER_RACK: 1, CHOICE_MS: 15000 });
  root.PoolTurn = config;
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
})(typeof self !== 'undefined' ? self : globalThis);
