'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('../src/policy.js');
const { Settings } = require('../src/settings.js');
const { SUPPORTED_CAPABILITIES, KNOWN_CAPABILITIES } = require('../src/bridge-contract.js');

const APP = '/Users/me/code/app';
const OTHER = '/Users/me/code/other';
const picked = [APP, OTHER];
const on = { enabled: true, folders: [APP] };
const call = (input, terminal = on, folders = picked) => policy.localAgentCall({ action: 'terminal.exec', input }, folders, terminal);
const DIGEST = 'a'.repeat(64);

test('the terminal is an allowed local action, and only when it is on', () => {
  assert.ok(policy.LOCAL_AGENT_ACTIONS.has('terminal.exec'));
  assert.throws(() => call({ command: 'ls', workspacePath: APP }, { enabled: false, folders: [APP] }), /terminal is off/i);
  assert.throws(() => call({ command: 'ls', workspacePath: APP }, null), /terminal is off/i);
});

test('it runs only in an opened folder the terminal is turned on for', () => {
  assert.throws(() => call({ command: 'ls', workspacePath: OTHER }), /not turned on for this folder/i);
  assert.throws(() => call({ command: 'ls', workspacePath: '/etc' }), /not inside a folder opened/i);
  assert.throws(() => call({ command: 'ls', workspacePath: 'relative' }), /absolute path/i);
  assert.throws(() => call({ command: 'ls' }), /absolute path/i);
  assert.throws(() => call({ command: 'ls', workspacePath: '/Users/me/code/app/../../../etc' }), /not inside a folder opened|not turned on/i);
  // A sub-folder of the opened folder is inside it.
  assert.equal(call({ command: 'ls', workspacePath: `${APP}/src` }).input.workspacePath, `${APP}/src`);
});

test('it is rebuilt field by field: nothing the page adds reaches the runtime', () => {
  const built = call({
    command: 'ls -la', workspacePath: APP, cwd: 'src', mode: 'plan', timeoutMs: 5000, sessionId: 'session_abc123',
    approval: { digest: DIGEST, network: true, extra: 'x' },
    env: { PATH: '/tmp' }, shell: '/bin/zsh', trustedStaging: false, approvalMode: 'auto', sandbox: 'none', denyWritePaths: [],
  });
  assert.deepEqual(built, {
    action: 'terminal.exec',
    input: { command: 'ls -la', workspacePath: APP, cwd: 'src', mode: 'plan', approval: { digest: DIGEST, network: true }, rules: [], timeoutMs: 5000, sessionId: 'session_abc123' },
  });
});

test('a bad command, working directory, mode or approval is dropped or refused', () => {
  assert.throws(() => call({ command: '   ', workspacePath: APP }), /needs a command/i);
  assert.throws(() => call({ command: 'ls\0', workspacePath: APP }), /malformed/i);
  assert.throws(() => call({ command: 'x'.repeat(8001), workspacePath: APP }), /too long/i);
  assert.throws(() => call({ command: 'ls', workspacePath: APP, cwd: '../other' }), /stay inside/i);
  assert.throws(() => call({ command: 'ls', workspacePath: APP, cwd: '/etc' }), /stay inside/i);
  assert.equal(call({ command: 'ls', workspacePath: APP, cwd: `${APP}/src` }).input.cwd, `${APP}/src`);
  assert.equal(call({ command: 'ls', workspacePath: APP, mode: 'bypass' }).input.mode, 'standard');
  for (const digest of ['', 'abc', 'Z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.equal('approval' in call({ command: 'ls', workspacePath: APP, approval: { digest } }).input, false);
  }
  assert.equal(call({ command: 'ls', workspacePath: APP, approval: { digest: DIGEST } }).input.approval.network, false);
  assert.equal(call({ command: 'ls', workspacePath: APP, timeoutMs: 99999999 }).input.timeoutMs, 600000);
  assert.equal(call({ command: 'ls', workspacePath: APP, timeoutMs: 5 }).input.timeoutMs, 1000);
  assert.equal('timeoutMs' in call({ command: 'ls', workspacePath: APP, timeoutMs: 'soon' }).input, false);
  assert.equal('sessionId' in call({ command: 'ls', workspacePath: APP, sessionId: 'a b; rm' }).input, false);
});

test('saved rules are kept only where they are well-formed and allowed', () => {
  const rules = call({
    command: 'npm test', workspacePath: APP,
    rules: [
      { words: ['npm', 'test'], scope: 'session' },
      { words: ['git', 'commit'], scope: 'folder', folder: APP },
      { words: ['git', 'fetch'], scope: 'session', network: true },
      { words: ['python', '-m', 'pytest'], scope: 'session' },
      { words: ['bash'], scope: 'session' },
      { words: ['python', 'script.py'], scope: 'session' },
      { words: ['python', '-m', 'http.server'], scope: 'session' },
      { words: ['rm', '-rf'], scope: 'session' },
      { words: ['env'], scope: 'session' },
      { words: ['npm', 'test; rm -rf ~'], scope: 'session' },
      { words: ['npm', '$(id)'], scope: 'session' },
      { words: ['npm', 'a b'], scope: 'session' },
      { words: [], scope: 'session' },
      { words: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], scope: 'session' },
      { words: ['npm', 'test'], scope: 'folder', folder: OTHER },
      { words: ['npm', 'test'], scope: 'folder' },
      null, 'x', 5, { scope: 'session' },
    ],
  }).input.rules;
  assert.deepEqual(rules, [
    { words: ['npm', 'test'], scope: 'session' },
    { words: ['git', 'commit'], scope: 'folder', folder: APP },
    { words: ['git', 'fetch'], scope: 'session', network: true },
    { words: ['python', '-m', 'pytest'], scope: 'session' },
  ]);
});

test('no more than 50 rules are sent', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ words: ['make', `target${i}`], scope: 'session' }));
  assert.equal(call({ command: 'make x', workspacePath: APP, rules: many }).input.rules.length, 50);
});

test('the other local actions are unchanged by the terminal', () => {
  assert.deepEqual(policy.localAgentCall({ action: 'file.read', input: { path: `${APP}/a.ts`, limit: 50 } }, picked), policy.localAgentCall({ action: 'file.read', input: { path: `${APP}/a.ts`, limit: 50 } }, picked, on));
  assert.throws(() => policy.localAgentCall({ action: 'shell.exec', input: { command: 'ls' } }, picked, on), /does not run/);
  assert.throws(() => policy.localAgentCall({ action: 'terminal.run', input: {} }, picked, on), /does not run/);
});

// ---------------------------------------------------------------- settings ---

function settingsIn(folders) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-settings-'));
  const real = folders.map((name) => { const dir = path.join(dataDir, name); fs.mkdirSync(dir); return dir; });
  const safeStorage = { isEncryptionAvailable: () => false };
  const settings = new Settings({ dataDir, safeStorage });
  for (const dir of real) settings.addWorkspace(dir);
  return { settings, dataDir, real, safeStorage };
}

test('the terminal is off, for no folder, until it is turned on', () => {
  const { settings } = settingsIn(['a']);
  assert.deepEqual(settings.terminal, { enabled: false, folders: [] });
  assert.equal(settings.runtimeArgs()[3], false);
});

test('turning it on and naming a folder survives a restart of the app', () => {
  const { settings, dataDir, real, safeStorage } = settingsIn(['a', 'b']);
  settings.setTerminalEnabled(true);
  settings.setTerminalFolder(real[0], true);
  assert.deepEqual(settings.terminal, { enabled: true, folders: [real[0]] });
  assert.equal(settings.runtimeArgs()[3], true);
  const reloaded = new Settings({ dataDir, safeStorage });
  assert.deepEqual(reloaded.terminal, { enabled: true, folders: [real[0]] });
});

test('only an opened folder can have the terminal, and closing the folder takes it away', () => {
  const { settings, real } = settingsIn(['a', 'b']);
  settings.setTerminalEnabled(true);
  assert.throws(() => settings.setTerminalFolder('/not/opened', true), /not opened/);
  settings.setTerminalFolder(real[1], true);
  settings.removeWorkspace(real[1]);
  assert.deepEqual(settings.terminal.folders, []);
  settings.addWorkspace(real[1]);
  assert.deepEqual(settings.terminal.folders, [real[1]], 'opened again, the earlier choice was only hidden');
});

test('turning it off forgets the folders, so turning it on again starts from none', () => {
  const { settings, real } = settingsIn(['a']);
  settings.setTerminalEnabled(true);
  settings.setTerminalFolder(real[0], true);
  settings.setTerminalEnabled(false);
  assert.deepEqual(settings.terminal, { enabled: false, folders: [] });
  settings.setTerminalEnabled(true);
  assert.deepEqual(settings.terminal, { enabled: true, folders: [] });
});

test('a damaged settings file means off', () => {
  const { settings } = settingsIn(['a']);
  for (const bad of [null, 'yes', 5, [], { enabled: 'true', folders: 'x' }]) {
    settings.data.terminal = bad;
    assert.deepEqual(settings.terminal, { enabled: false, folders: [] });
  }
});

// ---------------------------------------------------- the wiring (source) ---

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

test('the runtime has the terminal only while the person has it on, and logs every command', () => {
  const source = read('runtime.js');
  assert.match(source, /this\.terminalEnabled \? \{ ONECLAW_TERMINAL_ENABLED: 'true', ONECLAW_TERMINAL_AUDIT_FILE: path\.join\(this\.dataDir, 'terminal-audit\.jsonl'\) \} : \{\}/);
  assert.doesNotMatch(source, /ONECLAW_TERMINAL_ENABLED: process\.env/);
});

test('turning the terminal on is confirmed in a native dialog the page cannot draw; turning it off is not', () => {
  const source = read('bridge.js');
  // A refusal while a run is going comes first (no point asking), then the dialog, then the change.
  assert.match(source, /handle\('desktop:setTerminalEnabled', async \(value\) => \{ await assertNoRunningWork\(\); if \(value\) await confirmTerminal\(null\); return ops\.setTerminalEnabled\(value\); \}\);/);
  assert.match(source, /handle\('desktop:setTerminalFolder', async \(folder, on\) => \{ if \(on\) await confirmTerminal\(String\(folder \|\| ''\)\);/);
  assert.match(source, /localAgentCall\(body, settings\.workspaces, settings\.terminal, settings\.files\)/);
  assert.match(source, /async setTerminalEnabled\(value\) \{[\s\S]*?await restartRuntime\(\)/);
});

test('the page can ask for the setting but has no way to set it without the dialog', () => {
  const preload = read('preload.js');
  assert.match(preload, /setTerminalEnabled: \(value\) => ipcRenderer\.invoke\('desktop:setTerminalEnabled', value\)/);
  assert.doesNotMatch(read('bridge.js'), /ipcMain\.handle\('settings:setTerminal/, 'the local settings window does not bypass the dialog either');
});

test('the bridge advertises the terminal as a capability', () => {
  assert.ok(SUPPORTED_CAPABILITIES.includes('terminalV1'));
  assert.ok(KNOWN_CAPABILITIES.includes('terminalV1'));
});

test('stopping a conversation\'s terminal commands is wired from the page to the runtime', () => {
  const bridge = read('bridge.js');
  assert.match(bridge, /handleWithEvent\('desktop:terminalStop', async \(event, sessionId\) => \{/);
  assert.match(bridge, /runtime\.request\('POST', '\/v1\/terminal\/stop', \{ sessionId: id \}\)/);
  // Only a well-formed conversation id is sent on; a stopped runtime answers 0, not an error.
  assert.match(bridge, /\^\[A-Za-z0-9_:-\]\{4,200\}\$/);
  assert.match(bridge, /if \(runtime\.state\.status !== 'ready'\) return \{ ok: true, stopped: 0 \};/);
  assert.match(read('preload.js'), /terminalStop: \(sessionId\) => ipcRenderer\.invoke\('desktop:terminalStop', sessionId\)/);
});
