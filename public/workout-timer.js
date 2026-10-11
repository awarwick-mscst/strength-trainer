'use strict';
(function (root) {
  const create = (now = Date.now()) => ({ elapsedMs: 0, runningSince: now });
  const elapsed = (timer, now = Date.now()) => Math.max(0, timer.elapsedMs + (timer.runningSince === null ? 0 : Math.max(0, now - timer.runningSince)));
  function toggle(timer, now = Date.now()) {
    return timer.runningSince === null ? { elapsedMs: timer.elapsedMs, runningSince: now } : { elapsedMs: elapsed(timer, now), runningSince: null };
  }
  function format(seconds) {
    const value = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(value / 3600), minutes = Math.floor(value / 60) % 60, secs = value % 60;
    return (hours ? `${hours}:` : '') + `${hours ? String(minutes).padStart(2, '0') : minutes}:${String(secs).padStart(2, '0')}`;
  }
  root.StrengthTimer = { create, elapsed, toggle, format };
  if (typeof module !== 'undefined') module.exports = root.StrengthTimer;
})(globalThis);
