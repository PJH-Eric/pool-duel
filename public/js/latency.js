/* 延遲徽章：顯示在設定齒輪旁。只有線上連線時才出現。 */
(function (root) {
  'use strict';
  let ms = null, state = 'off';
  function bars(n) { let h = ''; for (let i = 0; i < 4; i++) h += '<i class="' + (i < n ? 'on' : '') + '"></i>'; return h; }
  function render() {
    document.querySelectorAll('.lat-slot').forEach(slot => {
      let el = slot.firstElementChild;
      if (!el) { el = document.createElement('span'); el.setAttribute('role', 'status'); slot.appendChild(el); }
      if (state === 'off') { el.className = 'lat hidden'; return; }
      let cls = 'good', n = 4, txt = ms + 'ms';
      if (ms == null) { cls = 'bad off'; n = 0; txt = '連線中'; }
      else if (ms > 250) { cls = 'bad'; n = 1; } else if (ms > 140) { cls = 'ok'; n = 2; } else if (ms > 70) { cls = 'good'; n = 3; }
      el.className = 'lat ' + cls;
      el.setAttribute('aria-label', ms == null ? '網路連線中' : '網路延遲 ' + ms + ' 毫秒');
      el.title = '與伺服器的來回延遲';
      el.innerHTML = '<span class="bars">' + bars(n) + '</span><span class="ms-text">' + txt + '</span>';
    });
  }
  root.Latency = {
    set(v) { ms = v == null ? null : Math.max(1, Math.round(v)); state = 'on'; render(); },
    off() { ms = null; state = 'off'; render(); },
    get ms() { return ms; },
    refresh: render
  };
})(typeof self !== 'undefined' ? self : this);
