'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('../src/policy.js');
const { Settings } = require('../src/settings.js');
const { SUPPORTED_CAPABILITIES, KNOWN_CAPABILITIES } = require('../src/bridge-contract.js');
const { readActivity } = require('../src/activity.js');

const APP = '/Users/me/code/app';
const OTHER = '/Users/me/code/other';
const picked = [APP, OTHER];
const on = { enabled: true, folders: [APP] };
const DIGEST = 'b'.repeat(64);
const call = (action, input, files = on, folders = picked) => policy.localAgentCall({ action, input }, folders, { enabled: false, folders: [] }, files);
const ops = [{ op: 'move', from: 'a.txt', to: 'b.txt' }];
const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

test('file operations are allowed local actions, and only while file management is on', () => {
  assert.ok(policy.LOCAL_AGENT_ACTIONS.has('files.plan') && policy.LOCAL_AGENT_ACTIONS.has('files.apply'));
  assert.throws(() => call('files.plan', { workspacePath: APP, operations: ops }, { enabled: false, folders: [APP] }), /File management is off/);
  assert.throws(() => call('files.plan', { workspacePath: APP, operations: ops }, null), /File management is off/);
});

test('they run only in an opened folder file management is turned on for', () => {
  assert.throws(() => call('files.plan', { workspacePath: '/Users/me/elsewhere', operations: ops }), /not inside a folder opened/);
  assert.throws(() => call('files.plan', { workspacePath: OTHER, operations: ops }), /not turned on for this folder/);
  assert.throws(() => call('files.plan', { workspacePath: 'relative/path', operations: ops }), /absolute path/);
  assert.throws(() => call('files.plan', { operations: ops }), /absolute path/);
  assert.deepEqual(call('files.plan', { workspacePath: `${APP}/sub`, operations: ops }).input.root, APP);
});

test('the request is rebuilt: only op, from and to survive, and the number of operations is bounded', () => {
  const built = call('files.plan', { workspacePath: APP, operations: [{ op: 'move', from: 'a', to: 'b', command: 'rm -rf /', path: '/etc', recursive: true }], extra: 1 });
  assert.deepEqual(built, { action: 'files.plan', input: { root: APP, operations: [{ op: 'move', from: 'a', to: 'b' }] } });
  for (const operations of [undefined, [], 'x', {}, Array.from({ length: 201 }, () => ({ op: 'mkdir', to: 'a' }))]) {
    assert.throws(() => call('files.plan', { workspacePath: APP, operations }), /between 1 and 200/);
  }
  const odd = call('files.plan', { workspacePath: APP, operations: [null, 5, 'x', { op: 5, from: 7 }] }).input.operations;
  assert.deepEqual(odd, [{ op: '' }, { op: '' }, { op: '' }, { op: '' }]);
});

test('an approval is the digest of the plan the person saw, and only doing it carries one', () => {
  assert.deepEqual(call('files.apply', { workspacePath: APP, operations: ops, approval: { digest: DIGEST } }).input.approval, { digest: DIGEST });
  assert.equal(call('files.apply', { workspacePath: APP, operations: ops, approval: { digest: 'x' } }).input.approval, undefined);
  assert.equal(call('files.apply', { workspacePath: APP, operations: ops, approval: true }).input.approval, undefined);
  assert.equal(call('files.apply', { workspacePath: APP, operations: ops }).input.approval, undefined);
  assert.equal(call('files.plan', { workspacePath: APP, operations: ops, approval: { digest: DIGEST } }).input.approval, undefined);
});

test('there is no delete action, and none that reaches outside an opened folder', () => {
  for (const action of ['files.delete', 'files.remove', 'file.delete', 'files.write', 'files.exec']) {
    assert.throws(() => call(action, { workspacePath: APP, operations: ops }), /does not run/);
  }
});

test('file management is advertised to the page as a capability', () => {
  assert.ok(SUPPORTED_CAPABILITIES.includes('filesV1') && KNOWN_CAPABILITIES.includes('filesV1'));
});

test('file management is off until turned on, only for opened folders, and turning it off forgets the folders', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-settings-'));
  const settings = new Settings({ dataDir, safeStorage: { isEncryptionAvailable: () => false } });
  assert.deepEqual(settings.files, { enabled: false, folders: [] });
  settings.addWorkspace(dataDir);
  settings.setFilesEnabled(true);
  assert.throws(() => settings.setFilesFolder('/not/opened', true), /not opened/);
  settings.setFilesFolder(dataDir, true);
  assert.deepEqual(settings.files, { enabled: true, folders: [dataDir] });
  assert.deepEqual(new Settings({ dataDir, safeStorage: { isEncryptionAvailable: () => false } }).files, { enabled: true, folders: [dataDir] });
  settings.setFilesEnabled(false);
  assert.deepEqual(settings.files, { enabled: false, folders: [] });
  // Terminal and file management are separate choices.
  assert.equal(settings.terminal.enabled, false);
});

test('turning it on and undoing a request are confirmed in a dialog the page cannot draw; turning it off is not; the trash is the system\'s', () => {
  const source = read('bridge.js');
  const handler = (name) => { const start = source.indexOf(`handle('desktop:${name}'`); return source.slice(start, source.indexOf("\n  handle('desktop:", start + 10)); };
  assert.match(handler('filesSetEnabled'), /if \(on\) \{\s*await confirmMcp\(/);
  assert.match(handler('filesSetFolder'), /if \(on\) \{[\s\S]*await confirmMcp\(/);
  assert.match(handler('filesUndo'), /await confirmMcp\(/);
  assert.match(source, /trashItem: \(target\) => shell\.trashItem\(target\)/);
  // The bridge itself never removes anything: removal is the system trash, or taking back a copy this request made.
  assert.doesNotMatch(source, /\bunlink\(|\brmSync\(|\bfs\.rm\(|\bfsp\.rm\(/);
  // Doing a request needs the digest from the approval, never one the bridge makes up.
  assert.match(source, /approvalDigest: approval && approval\.digest/);
  assert.match(source, /settings\.setFilesEnabled\(false\);\s*return \{ stopped/);
});

test('the control center lists file requests, and an "undone" line is not a request of its own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-activity-'));
  const journal = path.join(dir, 'j.jsonl');
  fs.writeFileSync(journal, `${[
    { id: 'a', at: Date.UTC(2026, 10, 25, 1), root: '/Users/me/p', status: 'applied', steps: [{ op: 'move' }, { op: 'trash' }] },
    { id: 'a', undoneAt: Date.UTC(2026, 10, 25, 2), undone: 1 },
    { id: 'b', at: Date.UTC(2026, 10, 25, 3), root: '/Users/me/p', status: 'partial', steps: [{ op: 'trash' }], error: 'x' },
  ].map((line) => JSON.stringify(line)).join('\n')}\n`);
  const rows = readActivity({ filesJournal: journal });
  assert.deepEqual(rows.map((row) => [row.source, row.outcome, row.title]), [['files', 'failed', '1 file operation'], ['files', 'ok', '2 file operations']]);
});
