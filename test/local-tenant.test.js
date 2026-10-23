'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LOCAL_TENANT, adoptLocalTasks } = require('../src/local-tenant');

test('gives saved tasks without a tenant the local one, and leaves the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tenant-'));
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, approvals: [{ id: 'a', taskId: 't1' }], tasks: [
    { id: 't1', metadata: { threadId: 'x' } },
    { id: 't2' },
    { id: 't3', metadata: { tenantId: 'other' } },
  ] }));
  assert.equal(adoptLocalTasks(file), 2);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.tasks.map((task) => task.metadata), [
    { threadId: 'x', tenantId: LOCAL_TENANT },
    { tenantId: LOCAL_TENANT },
    { tenantId: 'other' },
  ]);
  assert.deepEqual(saved.approvals, [{ id: 'a', taskId: 't1' }]);
  assert.equal(adoptLocalTasks(file), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('does nothing without a history', () => {
  assert.equal(adoptLocalTasks(path.join(os.tmpdir(), 'no-such-dir', 'tasks.json')), 0);
});
