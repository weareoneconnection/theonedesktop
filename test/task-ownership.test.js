'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createTaskOwnershipStore, identityKey } = require('../src/task-ownership');

test('local task ownership is isolated by both tenant and user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-owners-'));
  const alice = { tenantId: 'team-1', userId: 'alice' };
  const bob = { tenantId: 'team-1', userId: 'bob' };
  const otherTenant = { tenantId: 'team-2', userId: 'alice' };
  const store = createTaskOwnershipStore(dir);
  store.claim('task-1', alice);
  assert.throws(() => store.claim('task-1', bob), /already bound/);
  assert.equal(store.owns('task-1', alice), true);
  assert.equal(store.owns('task-1', bob), false);
  assert.equal(store.owns('task-1', otherTenant), false);
  assert.throws(() => store.assertOwns('task-1', bob), /does not belong/);
  assert.equal(createTaskOwnershipStore(dir).owns('task-1', alice), true);
});

test('identity must contain a tenant and user', () => {
  assert.throws(() => identityKey({ tenantId: '', userId: 'alice' }), /signed-in account/);
  assert.throws(() => identityKey({ tenantId: 'team', userId: '' }), /signed-in account/);
});

test('durable task index keeps an immutable dispatch session and monotonic receipt clock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-owners-index-'));
  const alice = { tenantId: 'team-1', userId: 'alice' };
  const store = createTaskOwnershipStore(dir);
  store.claim('task-1', alice, {
    threadId: 'thread_123456', sessionId: 'session_123456', createdAt: '2026-11-14T10:00:00.000Z',
  });
  store.record('task-1', alice, {
    threadId: 'thread_should_not_replace', sessionId: 'session_should_not_replace', updatedAt: '2026-11-14T10:05:00.000Z',
  });
  assert.equal(store.metadata('task-1', alice).sessionId, 'session_123456');
  assert.equal(store.metadata('task-1', alice).threadId, 'thread_123456');
  assert.equal(store.list(alice, { threadId: 'thread_123456' })[0].taskId, 'task-1');
  assert.equal(store.list(alice, { threadId: 'thread_other' }).length, 0);

  const first = store.receiptSequence('task-1', alice, `sha256:${'a'.repeat(64)}`, new Date('2026-11-14T10:06:00.000Z'));
  const same = store.receiptSequence('task-1', alice, `sha256:${'a'.repeat(64)}`, new Date('2026-11-14T10:07:00.000Z'));
  const next = store.receiptSequence('task-1', alice, `sha256:${'b'.repeat(64)}`, new Date('2026-11-14T10:08:00.000Z'));
  assert.deepEqual(same, first);
  assert.equal(next.sequence, first.sequence + 1);

  const reloaded = createTaskOwnershipStore(dir);
  assert.equal(reloaded.metadata('task-1', alice).sessionId, 'session_123456');
  assert.equal(reloaded.metadata('task-1', alice).sequence, 2);
});

test('version 1 owner files migrate without exposing tasks to another account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-owners-v1-'));
  const alice = { tenantId: 'team-1', userId: 'alice' };
  const bob = { tenantId: 'team-1', userId: 'bob' };
  fs.writeFileSync(path.join(dir, 'task-owners.json'), JSON.stringify({ version: 1, owners: { old: identityKey(alice) } }));
  const store = createTaskOwnershipStore(dir);
  assert.equal(store.owns('old', alice), true);
  assert.equal(store.owns('old', bob), false);
  assert.equal(store.metadata('old', alice).sessionId, undefined);
});
