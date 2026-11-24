'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activeRuns, refusalMessage, FRESH_MS } = require('../src/active-work');

const NOW = Date.UTC(2026, 10, 25, 2, 0, 0);
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

test('a run that is running, queued or verifying and recently written is live work', () => {
  const items = [
    { id: 'a', status: 'running', updatedAt: at(1_000) },
    { id: 'b', status: 'queued', updatedAt: at(60_000) },
    { id: 'c', status: 'verifying', updatedAt: at(5_000) },
  ];
  assert.deepEqual(activeRuns(items, NOW).map((item) => item.id), ['a', 'b', 'c']);
});

test('finished, failed and waiting runs are not live work', () => {
  const items = ['success', 'failed', 'cancelled', 'aborted', 'blocked', 'rejected', 'awaiting_approval', '', undefined]
    .map((status) => ({ status, updatedAt: at(1_000) }));
  assert.deepEqual(activeRuns(items, NOW), []);
});

test('a "running" run nothing has written to for a long time is a crash leftover and never blocks a restart', () => {
  assert.deepEqual(activeRuns([{ status: 'running', updatedAt: at(FRESH_MS + 1_000) }], NOW), []);
  assert.equal(activeRuns([{ status: 'running', updatedAt: at(FRESH_MS - 1_000) }], NOW).length, 1);
  // No usable time at all: cannot be shown to be live.
  assert.deepEqual(activeRuns([{ status: 'running' }, { status: 'running', updatedAt: 'nonsense' }], NOW), []);
});

test('anything that is not a list of runs counts as no work', () => {
  for (const value of [undefined, null, 'x', 5, {}, [null, 5, 'x']]) assert.deepEqual(activeRuns(value, NOW), []);
});

test('the refusal says how many runs and what to do, in both languages', () => {
  assert.match(refusalMessage(1, true), /A coding run is still going.*half-way/);
  assert.match(refusalMessage(3, true), /3 coding runs are still going/);
  assert.match(refusalMessage(2, false), /还有 2 个编程任务在运行/);
});
