/* ===== lobby-link.js — 「返回遊戲大廳」網址解析 =====
 * 優先序：?lobby=網址 → 本分頁先前記住的 → 來源頁(referrer) → null（按鈕隱藏）
 * 只接受 http(s) 絕對網址或相對路徑，避免 javascript: 之類的注入。
 */
(function (root) {
  'use strict';

  function resolve(queryValue, stored, referrer) {
    var raw = String(queryValue || stored || referrer || '').trim();
    if (!raw || !/^(https?:\/\/|\/|\.{1,2}\/)/i.test(raw)) return null;
    return raw;
  }

  var query = '', stored = '';
  try { query = new URLSearchParams(root.location ? root.location.search : '').get('lobby') || ''; } catch (e) {}
  try { stored = root.sessionStorage.getItem('pool-duel.lobby') || ''; } catch (e) {}

  var url = resolve(query, stored, root.document ? root.document.referrer : '');
  if (url && root.location && url.indexOf(root.location.origin + root.location.pathname) === 0) url = null;
  try { if (url && query) root.sessionStorage.setItem('pool-duel.lobby', url); } catch (e) {}

  root.LobbyLink = { url: url, resolve: resolve };
  var btn = root.document && root.document.getElementById('btnLobby');
  if (btn && url) { btn.href = url; btn.hidden = false; }
})(typeof self !== 'undefined' ? self : this);
