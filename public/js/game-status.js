(function (root) {
  'use strict';

  function create(render, timers) {
    const schedule = (timers && timers.setTimeout) || setTimeout;
    const cancel = (timers && timers.clearTimeout) || clearTimeout;
    let status = { text: '', mine: false };
    let activeToast = null;
    let toastTimer = null;
    let lastRevision;
    let hasRevision = false;

    function draw() {
      render(activeToast || { text: status.text, mine: status.mine, kind: null });
    }

    function update(text, mine, revision) {
      const changed = hasRevision && !Object.is(revision, lastRevision);
      status = { text, mine: !!mine };
      lastRevision = revision;
      hasRevision = true;
      if (changed) {
        if (toastTimer !== null) cancel(toastTimer);
        toastTimer = null;
        activeToast = null;
      }
      draw();
    }

    function toast(text, kind, duration) {
      if (toastTimer !== null) cancel(toastTimer);
      activeToast = { text, mine: false, kind: kind === 'foul' ? 'foul' : 'message' };
      draw();
      // Game-state updates dismiss notices immediately; this timeout is only a fallback.
      toastTimer = schedule(() => {
        toastTimer = null;
        activeToast = null;
        draw();
      }, duration || 2800);
    }

    return { update, toast };
  }

  root.PoolGameStatus = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PoolGameStatus;
})(typeof self !== 'undefined' ? self : globalThis);
