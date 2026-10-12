/* 本機儲存：暱稱、設定、戰績。全部包 try/catch（無痕、被擋時照樣能玩） */
(function (root) {
  'use strict';
  const KEY = 'pool-duel:v1';
  const DEFAULTS = {
    nickname: '',
    musicOn: true, musicVol: 0.5, sfxOn: true, sfxVol: 0.8, vibrate: true,
    aim: 'full', showSpin: false, bigNumbers: false, swapControls: false, reduceMotion: false, colorAssist: false,
    felt: 'classic', scene: 'bar', cue: 'maple',
    lastKind: 'nine', lastLevel: 'easy', lastMode: 'ai',
    stats: { wins: 0, losses: 0, draws: 0, potted: 0, bestRun: 0, games: 0 }
  };
  let data = null;
  function load() {
    if (data) return data;
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    data = Object.assign({}, DEFAULTS, raw || {});
    data.stats = Object.assign({}, DEFAULTS.stats, (raw && raw.stats) || {});
    return data;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignore */ } }
  function get(k) { return load()[k]; }
  function set(k, v) { load()[k] = v; save(); listeners.forEach(f => { try { f(k, v); } catch (e) { /* ignore */ } }); }
  function reset() { data = JSON.parse(JSON.stringify(DEFAULTS)); data.nickname = (load().nickname || ''); save(); listeners.forEach(f => f('*', null)); }
  const listeners = [];
  function onChange(f) { listeners.push(f); }
  function addStats(d) {
    const s = load().stats;
    Object.keys(d).forEach(k => { if (k === 'bestRun') s.bestRun = Math.max(s.bestRun, d[k]); else s[k] = (s[k] || 0) + d[k]; });
    save();
  }
  /* 每個瀏覽器分頁一個祕密 id（sessionStorage）：斷線重連靠它認出同一個人；分頁各自獨立，同機可開兩個分頁對打 */
  function clientId() {
    let id = '';
    try { id = sessionStorage.getItem('pool-duel:cid') || ''; } catch (e) { id = ''; }
    if (!id) {
      id = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
      try { sessionStorage.setItem('pool-duel:cid', id); } catch (e) { /* ignore */ }
    }
    return id;
  }
  root.Store = { get, set, reset, onChange, addStats, clientId, DEFAULTS };
})(typeof self !== 'undefined' ? self : this);
