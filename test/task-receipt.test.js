'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateKey } = require('../src/attestation');
const { identityKey, createTaskOwnershipStore } = require('../src/task-ownership');
const {
  TASK_RECEIPT_SCHEMA,
  buildTaskReceipt,
  taskReceiptStateDigest,
  verifyTaskReceipt,
} = require('../src/task-receipt');

function compactTask(overrides = {}) {
  return {
    id: 'local:Task_1234',
    status: 'success',
    threadId: 'thread_123456',
    createdAt: '2026-11-14T10:00:00.000Z',
    updatedAt: '2026-11-14T10:05:00.000Z',
    steps: [{ output: {
      schemaVersion: 'theone.code_execution_result.v2',
      workUnitId: 'code:Task_1234',
      lifecycleStatus: 'completed_verified',
      verified: true,
      verifyPassed: true,
      acceptancePassed: true,
      acceptanceAssurance: 'runtime_checks',
      resultDigest: `sha256:${'a'.repeat(64)}`,
      diffDigest: `sha256:${'b'.repeat(64)}`,
      changedFiles: [{ path: 'src/b.ts' }, { path: 'src/a.ts' }, { path: 'src/a.ts' }],
      retryable: false,
      nextAction: 'none',
      trustedStagingWriteback: { applied: true, secret: 'drop me' },
      ...overrides,
    } }],
  };
}

test('local task receipt signs only bounded structured evidence and detects tampering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-receipt-'));
  const key = loadOrCreateKey(dir);
  const identityBinding = identityKey({ tenantId: 'tenant-1', userId: 'alice' });
  const task = compactTask();
  const receipt = buildTaskReceipt({
    task,
    identityBinding,
    sessionId: 'session_123456',
    threadId: 'thread_123456',
    sequence: 3,
    issuedAt: '2026-11-14T10:05:01.000Z',
  }, { key });

  assert.equal(receipt.schemaVersion, TASK_RECEIPT_SCHEMA);
  assert.equal(receipt.identityBinding, identityBinding);
  assert.equal(receipt.sessionId, 'session_123456');
  assert.equal(receipt.taskId, 'local:Task_1234');
  assert.equal(receipt.sequence, 3);
  assert.deepEqual(receipt.changedFiles, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(receipt.verification, {
    verified: true, verifyPassed: true, acceptancePassed: true, acceptanceAssurance: 'runtime_checks',
  });
  assert.deepEqual(receipt.trustedStagingWriteback, { applied: true });
  assert.equal('summary' in receipt, false);
  assert.equal(verifyTaskReceipt(receipt, key.publicKey), true);
  assert.equal(verifyTaskReceipt({ ...receipt, lifecycleStatus: 'failed' }, key.publicKey), false);
  assert.equal(verifyTaskReceipt({ ...receipt, identityBinding: identityKey({ tenantId: 'tenant-2', userId: 'alice' }) }, key.publicKey), false);
});

test('receipt sequence is stable for a poll and increases when authoritative state changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-receipt-state-'));
  const identity = { tenantId: 'tenant-1', userId: 'alice' };
  const store = createTaskOwnershipStore(dir);
  store.claim('Task_1234', identity, { threadId: 'thread_123456', sessionId: 'session_123456' });
  const common = { task: compactTask(), identityBinding: identityKey(identity), sessionId: 'session_123456', threadId: 'thread_123456' };
  const digest = taskReceiptStateDigest(common);
  const first = store.receiptSequence('Task_1234', identity, digest, new Date('2026-11-14T10:05:01.000Z'));
  const repeated = store.receiptSequence('Task_1234', identity, digest, new Date('2026-11-14T10:06:00.000Z'));
  const changed = store.receiptSequence('Task_1234', identity, taskReceiptStateDigest({ ...common, task: compactTask({ lifecycleStatus: 'failed', verified: false }) }), new Date('2026-11-14T10:07:00.000Z'));
  assert.deepEqual(first, repeated);
  assert.deepEqual(first, { sequence: 1, issuedAt: '2026-11-14T10:05:01.000Z' });
  assert.deepEqual(changed, { sequence: 2, issuedAt: '2026-11-14T10:07:00.000Z' });
});

test('missing dispatch session remains explicit and cannot look session-bound', () => {
  const key = loadOrCreateKey(fs.mkdtempSync(path.join(os.tmpdir(), 'theone-receipt-legacy-')));
  const receipt = buildTaskReceipt({
    task: compactTask(), identityBinding: identityKey({ tenantId: 't', userId: 'u' }),
    sessionId: null, threadId: 'thread_123456', sequence: 1, issuedAt: new Date().toISOString(),
  }, { key });
  assert.equal(receipt.sessionId, null);
  assert.equal(verifyTaskReceipt(receipt, key.publicKey), true);
});
