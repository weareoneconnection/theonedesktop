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
