'use strict';

/**
 * Whether the local runtime is in the middle of work a restart would cut off. Turning the terminal on
 * or off, changing a key, installing Codex and "restart" all restart the runtime; a coding run that is
 * going at that moment would be stopped half-way, so those are refused until it ends.
 */

const ACTIVE = new Set(['running', 'queued', 'verifying']);
// A run that has not written anything for this long is a leftover of a crash, not live work: it must
// not block a restart forever (restarting is also how the person recovers a stuck runtime).
const FRESH_MS = 20 * 60 * 1000;

function activeRuns(items, now = Date.now(), freshMs = FRESH_MS) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!item || !ACTIVE.has(String(item.status || '').toLowerCase())) return false;
    const touched = Date.parse(item.updatedAt || item.createdAt || '');
    return Number.isFinite(touched) && now - touched <= freshMs;
  });
}

function refusalMessage(count, english) {
  return english
    ? `${count === 1 ? 'A coding run is' : `${count} coding runs are`} still going on this computer, and this would stop ${count === 1 ? 'it' : 'them'} half-way. Wait until ${count === 1 ? 'it ends' : 'they end'}, or stop ${count === 1 ? 'it' : 'them'} first, then try again.`
    : `这台电脑上还有 ${count} 个编程任务在运行，现在这样做会把它们中途打断。请等它们结束，或先停止它们，然后再试。`;
}

module.exports = { activeRuns, refusalMessage, ACTIVE, FRESH_MS };
