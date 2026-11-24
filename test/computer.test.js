'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isBlocked, isAllowed, validateApp, normalizeApp, AppError } = require('../src/computer/apps');
const { ComputerSessions, SessionError } = require('../src/computer/session');
const { RecordStore } = require('../src/computer/records');
const { createComputerActions } = require('../src/computer/actions');
const { unsupportedProvider } = require('../src/computer/provider');
const { localAgentCall, LOCAL_AGENT_ACTIONS } = require('../src/policy');
const { SUPPORTED_CAPABILITIES } = require('../src/bridge-contract');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const SID = 'session_12345';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'computer-test-'));

// ------------------------------------------------------------------- applications ---

test('apps that hold passwords or system privacy can never be added, however they are spelled', () => {
  for (const name of ['Keychain Access', 'keychain access.app', 'System Settings', 'System Preferences', '1Password 7', '1PASSWORD', 'Bitwarden', 'LastPass', 'KeePassXC', 'Passwords', 'Ledger Live', 'MetaMask']) {
    assert.equal(isBlocked(name), true, name);
    assert.throws(() => validateApp(name), (error) => error instanceof AppError && error.code === 'blocked', name);
  }
  assert.equal(isBlocked('Notes'), false);
  assert.equal(isBlocked('Safari'), false);
});

test('an app name is checked: a string, bounded, no control characters or path separators', () => {
  assert.equal(validateApp('  Notes.app '), 'Notes');
  for (const bad of ['', '   ', 'a'.repeat(81), 'a\nb', 'a/b', 'a\\b', 'a\u0000b', 5, null, {}, ['Notes']]) {
    assert.throws(() => validateApp(bad), (error) => error instanceof AppError && error.code === 'bad_name', String(bad));
  }
});

test('only an app on the list is allowed, matched by name, and a blocked one never is', () => {
  assert.equal(isAllowed(['Notes', 'Safari'], 'notes.APP'), true);
  assert.equal(isAllowed(['Notes'], 'Notes 2'), false);
  assert.equal(isAllowed([], 'Notes'), false);
  assert.equal(isAllowed(undefined, 'Notes'), false);
  assert.equal(isAllowed(['1Password'], '1Password'), false);
  assert.equal(normalizeApp('  My   App.app'), 'my app');
});

// ---------------------------------------------------------------------- sessions ---

test('a session has a step limit and then refuses, and the limit applies per conversation', () => {
  const sessions = new ComputerSessions({ maxSteps: 3 });
  assert.equal(sessions.step('a-session').stepsLeft, 2);
  sessions.step('a-session'); sessions.step('a-session');
  assert.throws(() => sessions.step('a-session'), (error) => error instanceof SessionError && error.code === 'step_limit');
  assert.equal(sessions.step('b-session').stepsLeft, 2);
});

test('a session has a time limit', () => {
  let now = 1_000;
  const sessions = new ComputerSessions({ maxMs: 600, now: () => now });
  sessions.step('s-one');
  now += 601;
  assert.throws(() => sessions.step('s-one'), (error) => error.code === 'time_limit');
});

test('a look needs a conversation', () => {
  assert.throws(() => new ComputerSessions().step(''), (error) => error.code === 'no_session');
  assert.throws(() => new ComputerSessions().step(undefined), (error) => error.code === 'no_session');
});

test('the emergency stop ends every session and keeps them ended until released', () => {
  const sessions = new ComputerSessions();
  sessions.approve('s-one', 'notes');
  sessions.stopAll();
  assert.equal(sessions.isApproved('s-one', 'notes'), false);
  assert.throws(() => sessions.step('s-one'), (error) => error.code === 'halted');
  assert.throws(() => sessions.step('another-session'), (error) => error.code === 'halted');
  assert.throws(() => sessions.approve('s-one', 'notes'), (error) => error.code === 'halted');
  sessions.release();
  assert.equal(sessions.step('s-one').stepsLeft, 29);
});

test('locking the screen or sleeping forgets every approval but keeps the step count', () => {
  const sessions = new ComputerSessions({ maxSteps: 5 });
  sessions.approve('s-one', 'notes');
  sessions.step('s-one');
  sessions.interrupt();
  assert.equal(sessions.isApproved('s-one', 'notes'), false);
  assert.equal(sessions.step('s-one').stepsLeft, 3);
});

test('the stop shortcut is wanted only while something is approved', () => {
  const seen = [];
  const sessions = new ComputerSessions({ onActive: (active) => seen.push(active) });
  sessions.approve('s-one', 'notes'); sessions.approve('s-one', 'safari');
  sessions.interrupt();
  sessions.approve('s-two', 'notes');
  sessions.stopAll();
  assert.deepEqual(seen, [true, false, true, false]);
});

// ----------------------------------------------------------------------- records ---

test('records are written privately, and ones past the retention are deleted with their pictures', () => {
  const dir = tmp();
  let now = Date.UTC(2026, 10, 1);
  const store = new RecordStore({ dir, retentionDays: 7, now: () => now });
  const old = store.add({ session: SID, app: 'Notes', kind: 'screenshot', image: PNG });
  assert.equal(fs.existsSync(path.join(dir, 'computer-shots', old.file)), true);
  assert.equal(fs.statSync(path.join(dir, 'computer-shots', old.file)).mode & 0o077, 0);
  now += 8 * 86_400_000;
  const fresh = store.add({ session: SID, app: 'Notes', kind: 'screenshot', image: PNG });
  assert.deepEqual(store.entries().map((entry) => entry.id), [fresh.id]);
  assert.equal(fs.existsSync(path.join(dir, 'computer-shots', old.file)), false);
  assert.equal(store.count(), 1);
});

test('clearing the records deletes the pictures too, and survives a half-written log', () => {
  const dir = tmp();
  const store = new RecordStore({ dir });
  store.add({ session: SID, app: 'Notes', kind: 'screenshot', image: PNG });
  fs.appendFileSync(store.log, '{"id":"torn');
  assert.equal(store.entries().length, 1);
  store.clear();
  assert.equal(fs.existsSync(store.shots), false);
  assert.equal(store.entries().length, 0);
});

test('a record file name that is not one this store wrote is never deleted', () => {
  const dir = tmp();
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'x');
  const store = new RecordStore({ dir });
  store.removeShot('../victim.txt');
  assert.equal(fs.existsSync(victim), true);
});

// ------------------------------------------------------------------------ actions ---

function setup({ enabled = true, apps = ['Notes'], provider, maxSteps } = {}) {
  const records = new RecordStore({ dir: tmp() });
  const sessions = new ComputerSessions({ maxSteps });
  const calls = [];
  const fake = provider || {
    supported: true,
    async captureWindow(app) { calls.push(['capture', app]); return { png: PNG, width: 800, height: 600 }; },
    async appState(app) { calls.push(['state', app]); return { running: true, frontmost: true, windows: ['Shopping list‮'] }; },
  };
  const actions = createComputerActions({ settings: () => ({ enabled, apps }), provider: fake, sessions, records });
  return { actions, sessions, records, calls };
}

test('everything is refused while computer use is off, and nothing is captured', async () => {
  const { actions, calls } = setup({ enabled: false });
  assert.equal((await actions.screenshot({ app: 'Notes', sessionId: SID, approved: true })).code, 'off');
  assert.equal((await actions.state({ app: 'Notes' })).code, 'off');
  assert.deepEqual(calls, []);
});

test('an app the person did not add, or one that is blocked, is refused', async () => {
  const { actions, calls } = setup({ apps: ['Notes', 'Keychain Access'] });
  assert.equal((await actions.screenshot({ app: 'Mail', sessionId: SID, approved: true })).code, 'app_not_allowed');
  assert.equal((await actions.screenshot({ app: 'Keychain Access', sessionId: SID, approved: true })).code, 'blocked');
  assert.equal((await actions.state({ app: 'Mail' })).code, 'app_not_allowed');
  assert.deepEqual(calls, []);
});

test('with no verified capture, every look is refused and says why', async () => {
  const { actions } = setup({ provider: unsupportedProvider });
  const answer = await actions.screenshot({ app: 'Notes', sessionId: SID, approved: true });
  assert.equal(answer.code, 'capture_unsupported');
  assert.match(answer.message, /cannot capture/);
});

test('the first look at an app in a conversation asks; only a boolean true counts as the approval', async () => {
  const { actions, calls } = setup();
  for (const approved of [undefined, false, 'true', 1, {}, null]) assert.equal((await actions.screenshot({ app: 'Notes', sessionId: SID, approved })).status, 'needs_approval');
  assert.deepEqual(calls, []);
  const first = await actions.screenshot({ app: 'Notes', sessionId: SID, approved: true });
  assert.equal(first.status, 'ok');
  assert.equal(first.image.mime, 'image/png');
  assert.equal(Buffer.from(first.image.base64, 'base64').equals(PNG), true);
  assert.equal(first.outputIsData, true);
  // Later looks in the same conversation need no new approval; another conversation asks again.
  assert.equal((await actions.screenshot({ app: 'notes', sessionId: SID })).status, 'ok');
  assert.equal((await actions.screenshot({ app: 'Notes', sessionId: 'another_session' })).status, 'needs_approval');
});

test('each look is recorded on this computer, with the picture', async () => {
  const { actions, records } = setup();
  await actions.screenshot({ app: 'Notes', sessionId: SID, approved: true });
  const [entry] = records.entries();
  assert.equal(entry.app, 'Notes');
  assert.equal(entry.kind, 'screenshot');
  assert.equal(fs.existsSync(path.join(records.shots, entry.file)), true);
});

test('past the step limit a look is refused, and a refused look captures nothing', async () => {
  const { actions, calls } = setup({ maxSteps: 2 });
  await actions.screenshot({ app: 'Notes', sessionId: SID, approved: true });
  await actions.screenshot({ app: 'Notes', sessionId: SID });
  const refused = await actions.screenshot({ app: 'Notes', sessionId: SID });
  assert.equal(refused.code, 'step_limit');
  assert.equal(calls.filter((call) => call[0] === 'capture').length, 2);
});

test('after the emergency stop nothing is looked at, even with an approval', async () => {
  const { actions, sessions, calls } = setup();
  await actions.screenshot({ app: 'Notes', sessionId: SID, approved: true });
  sessions.stopAll();
  const answer = await actions.screenshot({ app: 'Notes', sessionId: SID, approved: true });
  assert.equal(answer.code, 'halted');
  assert.equal(calls.filter((call) => call[0] === 'capture').length, 1);
});

test('a failing or empty capture is an answer, not a crash, and is not recorded', async () => {
  for (const provider of [
    { supported: true, async captureWindow() { throw new Error('window hidden'); }, async appState() { return {}; } },
    { supported: true, async captureWindow() { return { png: Buffer.alloc(0) }; }, async appState() { return {}; } },
    { supported: true, async captureWindow() { return { png: 'not a buffer' }; }, async appState() { return {}; } },
    { supported: true, async captureWindow() { return { png: Buffer.alloc(9 * 1024 * 1024) }; }, async appState() { return {}; } },
  ]) {
    const { actions, records } = setup({ provider });
    assert.equal((await actions.screenshot({ app: 'Notes', sessionId: SID, approved: true })).code, 'capture_failed');
    assert.equal(records.entries().length, 0);
  }
});

test('the state of an app is cleaned text, and needs no approval', async () => {
  const { actions } = setup();
  const answer = await actions.state({ app: 'Notes' });
  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.windows, ['Shopping list']);
  assert.equal(answer.frontmost, true);
});

// ------------------------------------------------------------------------- bridge ---

test('the chat can name only an application, the conversation and an approval', () => {
  assert.ok(LOCAL_AGENT_ACTIONS.has('computer.screenshot') && LOCAL_AGENT_ACTIONS.has('computer.state'));
  const call = localAgentCall({ action: 'computer.screenshot', input: { app: ' Notes ', sessionId: SID, approved: true, x: 1, y: 2, command: 'rm -rf /', path: '/etc' } }, [], { enabled: false, folders: [] });
  assert.deepEqual(call, { action: 'computer.screenshot', input: { app: 'Notes', sessionId: SID, approved: true } });
  assert.deepEqual(localAgentCall({ action: 'computer.screenshot', input: { app: 'Notes', approved: 'true' } }, [], { enabled: false, folders: [] }).input, { app: 'Notes' });
  assert.deepEqual(localAgentCall({ action: 'computer.state', input: { app: 'Notes', sessionId: SID, approved: true } }, [], { enabled: false, folders: [] }).input, { app: 'Notes' });
  for (const app of [undefined, '', 5, ['Notes'], 'a/b', 'a\nb', 'x'.repeat(81)]) {
    assert.throws(() => localAgentCall({ action: 'computer.screenshot', input: { app } }, [], { enabled: false, folders: [] }), /names one application/);
  }
});

test('there is no click, type or hotkey action to ask for', () => {
  for (const action of ['computer.click', 'computer.type', 'computer.hotkey', 'desktop.click', 'desktop.type', 'desktop.screenshot']) {
    assert.throws(() => localAgentCall({ action, input: { app: 'Notes' } }, [], { enabled: false, folders: [] }), /does not run/);
  }
});

test('it is not advertised to the web app until a capture has been verified', () => {
  assert.equal(SUPPORTED_CAPABILITIES.includes('computerReadV1'), false);
});
