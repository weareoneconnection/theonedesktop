'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpManager } = require('../src/mcp/manager.js');
const { McpError } = require('../src/mcp/client.js');
const { validateServerDefinition, buildChildEnv, describeCommandLine, FORBIDDEN_ENV } = require('../src/mcp/config.js');
const { Settings } = require('../src/settings.js');
const { toolListDigest } = require('../src/mcp/sanitize.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');
const realTmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mgr-')));

// ------------------------------------------------------------------ config ---

test('a server definition: one program, a list of arguments, declared variables', () => {
  const def = validateServerDefinition({ name: 'files', command: 'npx', args: ['-y', '@x/server', '/Users/me/docs'], env: { API_TOKEN: 'abc' } });
  assert.deepEqual({ name: def.name, command: def.command, args: def.args, envNames: def.envNames }, { name: 'files', command: 'npx', args: ['-y', '@x/server', '/Users/me/docs'], envNames: ['API_TOKEN'] });
  assert.equal(def.envValues.API_TOKEN, 'abc');
});

test('what is refused in a definition', () => {
  const bad = (input, pattern, existing = []) => assert.throws(() => validateServerDefinition(input, existing), pattern);
  const ok = { name: 'files', command: 'npx' };
  bad(null, /needs a definition/);
  bad([], /needs a definition/);
  for (const name of ['', 'Files', 'a b', 'a/b', '-x', 'x'.repeat(33), 5]) bad({ ...ok, name }, /name must be/);
  bad(ok, /already exists/, [{ name: 'files' }]);
  bad(ok, /At most 12/, Array.from({ length: 12 }, (_, i) => ({ name: `s${i}` })));
  for (const command of ['', 'npx -y x', 'a\nb', 'a\0b', 'x'.repeat(501), 5, 'sh -c "x"']) bad({ ...ok, command }, /command must|program only/);
  bad({ ...ok, args: 'x' }, /must be a list/);
  bad({ ...ok, args: Array(51).fill('a') }, /At most 50/);
  bad({ ...ok, args: ['a\nb'] }, /one line/);
  bad({ ...ok, args: [5] }, /one line/);
  bad({ ...ok, args: ['x'.repeat(1001)] }, /one line/);
  bad({ ...ok, env: [] }, /names and values/);
  bad({ ...ok, env: { lower: 'x' } }, /not a valid variable name/);
  bad({ ...ok, env: { 'A B': 'x' } }, /not a valid variable name/);
  bad({ ...ok, env: { API: 5 } }, /must be text/);
  bad({ ...ok, env: { API: 'x'.repeat(4001) } }, /must be text/);
  bad({ ...ok, env: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`V${i}`, 'x'])) }, /At most 20/);
});

test('variables that change what programs run are refused, whatever the server says it needs', () => {
  for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'PYTHONPATH', 'GIT_SSH_COMMAND', 'ELECTRON_RUN_AS_NODE', 'npm_config_registry', 'SHELL', 'IFS']) {
    assert.ok(FORBIDDEN_ENV.test(name), name);
    assert.throws(() => validateServerDefinition({ name: 'files', command: 'npx', env: { [name]: 'x' } }), /cannot be set|not a valid variable name/, name);
  }
});

test('a server starts with a short environment: the allowlist, the PATH given, what the person declared', () => {
  const source = { PATH: '/usr/bin', HOME: '/Users/me', USER: 'me', LANG: 'en_US.UTF-8', ANTHROPIC_API_KEY: 'sk-ant-secret', GITHUB_TOKEN: 'ghp_x', DATABASE_URL: 'postgres://u:p@h/db', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' };
  const env = buildChildEnv({ declared: { API_TOKEN: 'abc', NODE_OPTIONS: '--require x', PATH: '/evil' }, pathValue: '/opt/bin:/usr/bin', source, platform: 'darwin' });
  assert.deepEqual(env, { PATH: '/opt/bin:/usr/bin', HOME: '/Users/me', USER: 'me', LANG: 'en_US.UTF-8', API_TOKEN: 'abc' });
});

test('the confirmation shows the command line and the names of variables, never their values', () => {
  const shown = describeCommandLine({ command: 'npx', args: ['-y', '@x/server', 'a path', '$(rm)'], envNames: ['API_TOKEN'] });
  assert.equal(shown.line, 'npx -y @x/server "a path" "$(rm)"');
  assert.deepEqual(shown.env, ['API_TOKEN']);
});

// ---------------------------------------------------------------- settings ---

function settingsIn({ encryption = true } = {}) {
  const dataDir = realTmp();
  const safeStorage = {
    isEncryptionAvailable: () => encryption,
    encryptString: (value) => Buffer.from(`enc:${value}`.split('').reverse().join('')),
    decryptString: (buffer) => buffer.toString().split('').reverse().join('').replace(/^enc:/, ''),
  };
  return { settings: new Settings({ dataDir, safeStorage }), dataDir, safeStorage };
}
const def = (extra = {}) => validateServerDefinition({ name: 'files', command: 'npx', args: ['-y', 'x'], ...extra });

test('a server is stored turned off, with nothing approved, and its variables encrypted', () => {
  const { settings, dataDir } = settingsIn();
  const id = settings.addMcpServer(def({ env: { API_TOKEN: 'hunter2hunter2' } }));
  const [server] = settings.mcpServers;
  assert.deepEqual({ id: server.id, enabled: server.enabled, approvedDigest: server.approvedDigest, enabledTools: server.enabledTools, envNames: server.envNames }, { id, enabled: false, approvedDigest: '', enabledTools: [], envNames: ['API_TOKEN'] });
  assert.equal('env' in server, false, 'a page never sees values');
  assert.equal(settings.mcpEnv(id).API_TOKEN, 'hunter2hunter2');
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), /hunter2hunter2/);
  assert.equal(fs.statSync(path.join(dataDir, 'settings.json')).mode & 0o777, 0o600);
});

test('without encryption a server that needs a secret is not stored at all, and one that needs none is', () => {
  const { settings } = settingsIn({ encryption: false });
  assert.throws(() => settings.addMcpServer(def({ env: { API_TOKEN: 'x' } })), /Encryption is not available/);
  assert.equal(settings.mcpServers.length, 0);
  settings.addMcpServer(def());
  assert.equal(settings.mcpServers.length, 1);
});

test('what was approved is forgotten when a server is turned off', () => {
  const { settings } = settingsIn();
  const id = settings.addMcpServer(def());
  settings.setMcpEnabled(id, true);
  settings.setMcpTools(id, ['read', 'read', 'list'], 'abc');
  assert.deepEqual(settings.mcpServers[0].enabledTools, ['read', 'list']);
  assert.equal(settings.mcpServers[0].approvedDigest, 'abc');
  settings.setMcpEnabled(id, false);
  assert.deepEqual({ e: settings.mcpServers[0].enabled, t: settings.mcpServers[0].enabledTools, d: settings.mcpServers[0].approvedDigest }, { e: false, t: [], d: '' });
});

test('removing, unknown ids, a damaged file, and a reload', () => {
  const { settings, dataDir, safeStorage } = settingsIn();
  const id = settings.addMcpServer(def());
  assert.throws(() => settings.setMcpEnabled('srv_nope', true), /does not exist/);
  assert.equal(new Settings({ dataDir, safeStorage }).mcpServers.length, 1);
  settings.removeMcpServer(id);
  assert.equal(settings.mcpServers.length, 0);
  for (const bad of [null, 'x', 5, [], { servers: 'x' }, { servers: [null, 5, { id: 1 }] }]) { settings.data.mcp = bad; assert.deepEqual(settings.mcpServers, []); }
});

// ----------------------------------------------------------------- manager ---

/** A store the manager reads, with one server running the fake. */
function fixture({ modes = [], env = {}, limits = {}, approved = true, enabled = true, tools = ['echo', 'slow', 'crash', 'hang', 'env', 'cwd', 'fail'], digest, extraEnv = {} } = {}) {
  const dataDir = realTmp();
  const server = { id: 'srv_1', name: 'fake', command: process.execPath, args: [FAKE], envNames: Object.keys(env), enabled, approvedDigest: approved ? (digest || 'pending') : '', enabledTools: tools };
  const store = { list: () => [server], get: (id) => (id === server.id ? server : null), env: () => env };
  const audit = [];
  const manager = new McpManager({
    store, dataDir, pathValue: () => process.env.PATH, audit: (entry) => audit.push(entry),
    limits: { requestTimeoutMs: 1500, initTimeoutMs: 1500, ...limits },
    childEnv: ({ declared, pathValue }) => ({ ...buildChildEnv({ declared, pathValue }), FAKE_MODES: modes.join(','), ...extraEnv }),
  });
  return { manager, server, audit, dataDir, store };
}
/** Approve exactly what the server lists, the way the settings page does. */
async function approve(f) {
  const found = await f.manager.discover('srv_1');
  f.server.approvedDigest = found.digest;
  await f.manager.stop('srv_1');
  f.manager.reset('srv_1');
  return found;
}
const refused = async (promise, code) => assert.rejects(promise, (error) => { assert.ok(error instanceof McpError, String(error)); assert.equal(error.code, code, error.message); return true; });
test.afterEach(() => { global.__managers?.splice(0).forEach((m) => void m.stopAll()); });
const track = (f) => { (global.__managers ||= []).push(f.manager); return f; };

test('nothing is started for a call that is not allowed', async () => {
  const cases = [
    [fixture({ enabled: false }), 'disabled'],
    [fixture({ tools: ['slow'] }), 'tool_not_enabled'],
    [fixture({ approved: false }), 'not_approved'],
  ];
  for (const [f, code] of cases) {
    track(f);
    await refused(f.manager.call('srv_1', 'echo', { text: 'x' }), code);
    assert.equal(f.manager.status('srv_1').running, false, code);
  }
  const f = track(fixture());
  await refused(f.manager.call('srv_nope', 'echo', {}), 'unknown_server');
});

test('an approved tool runs, the server\'s own folder is its working directory, and the call is audited', async () => {
  const f = track(fixture());
  await approve(f);
  const result = await f.manager.call('srv_1', 'echo', { text: 'hello', token: 'ghp_abcdefghijklmnopqrstuv' }, { by: 'tester' });
  assert.equal(result.text, 'hello');
  assert.equal((await f.manager.call('srv_1', 'cwd', {})).text, path.join(f.dataDir, 'mcp', 'fake'));
  const entry = f.audit.find((e) => e.tool === 'echo');
  assert.deepEqual({ server: entry.server, outcome: entry.outcome, by: entry.by }, { server: 'fake', outcome: 'ok', by: 'tester' });
  assert.match(entry.argsDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(f.audit), /ghp_abcdefghijklmnopqrstuv/);
  assert.match(entry.resultDigest, /^[0-9a-f]{64}$/);
});

test('a refusal is audited too, with why', async () => {
  const f = track(fixture({ tools: [] }));
  await refused(f.manager.call('srv_1', 'echo', {}), 'tool_not_enabled');
  assert.deepEqual({ outcome: f.audit[0].outcome, code: f.audit[0].code }, { outcome: 'refused_or_failed', code: 'tool_not_enabled' });
});

test('the server gets the declared variables and none of this app\'s', async () => {
  process.env.HOST_SECRET_FOR_TEST = 'do-not-leak';
  try {
    const f = track(fixture({ env: { DECLARED_VAR: 'declared' } }));
    await approve(f);
    const [declared, hostSecret, count] = (await f.manager.call('srv_1', 'env', {})).text.split('|');
    assert.equal(declared, 'declared');
    assert.equal(hostSecret, '');
    assert.ok(Number(count) < 15, `a short environment, not ${count} variables`);
  } finally { delete process.env.HOST_SECRET_FOR_TEST; }
});

test('a server that changes its tools after approval is stopped, and stays refused', async () => {
  const state = path.join(realTmp(), 'starts');
  const f = track(fixture({ modes: ['drift'], extraEnv: { FAKE_STATE: state } }));
  await approve(f);
  // The server now describes `echo` differently: the third start says something else than the first two.
  await f.manager.stop('srv_1');
  await refused(f.manager.call('srv_1', 'echo', { text: 'x' }), 'changed');
  assert.equal(f.manager.status('srv_1').running, false, 'it was stopped');
  assert.equal(f.manager.status('srv_1').changed, true);
  await refused(f.manager.call('srv_1', 'echo', { text: 'x' }), 'changed');
  // Looking at it again and approving what it says now is the way back.
  await approve(f);
  assert.equal((await f.manager.call('srv_1', 'echo', { text: 'back' })).text, 'back');
});

test('a "list changed" notice re-reads the list: unchanged, it carries on', async () => {
  const f = track(fixture({ modes: ['listchanged'] }));
  await approve(f);
  assert.equal((await f.manager.call('srv_1', 'echo', { text: 'one' })).text, 'one');
  assert.equal((await f.manager.call('srv_1', 'echo', { text: 'two' })).text, 'two');
  assert.equal(f.manager.status('srv_1').changed, false);
});

test('a server that keeps crashing is stopped for good until the person restarts it', async () => {
  const f = track(fixture({ limits: { maxCrashes: 2 } }));
  await approve(f);
  for (let i = 0; i < 3; i += 1) await refused(f.manager.call('srv_1', 'crash', {}), 'server_exited');
  assert.equal(f.manager.status('srv_1').failed, true);
  await refused(f.manager.call('srv_1', 'echo', { text: 'x' }), 'failed');
  f.manager.reset('srv_1');
  assert.equal((await f.manager.call('srv_1', 'echo', { text: 'x' })).text, 'x');
});

test('an idle server is stopped, and started again when needed', async () => {
  const f = track(fixture({ limits: { idleMs: 250 } }));
  await approve(f);
  await f.manager.call('srv_1', 'echo', { text: 'x' });
  assert.equal(f.manager.status('srv_1').running, true);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(f.manager.status('srv_1').running, false);
  assert.equal((await f.manager.call('srv_1', 'echo', { text: 'again' })).text, 'again');
});

test('only so many calls at once, a short queue, and then it says it is busy', async () => {
  const f = track(fixture({ limits: { maxConcurrent: 2, maxQueue: 1 } }));
  await approve(f);
  const slow = () => f.manager.call('srv_1', 'slow', { ms: 500 });
  const calls = [slow(), slow(), slow()];
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual({ active: f.manager.status('srv_1').active, queued: f.manager.status('srv_1').queued }, { active: 2, queued: 1 });
  await refused(slow(), 'busy');
  const results = await Promise.all(calls);
  assert.deepEqual(results.map((r) => r.text), ['done', 'done', 'done']);
  assert.deepEqual({ active: f.manager.status('srv_1').active, queued: f.manager.status('srv_1').queued }, { active: 0, queued: 0 });
});

test('a call that is never answered times out, and the server keeps working', async () => {
  const f = track(fixture({ limits: { requestTimeoutMs: 400 } }));
  await approve(f);
  await refused(f.manager.call('srv_1', 'hang', {}), 'timeout');
  assert.equal((await f.manager.call('srv_1', 'echo', { text: 'ok' })).text, 'ok');
});

test('stopping everything ends every server', async () => {
  const f = track(fixture());
  await approve(f);
  await f.manager.call('srv_1', 'echo', { text: 'x' });
  await f.manager.stopAll();
  assert.equal(f.manager.status('srv_1').running, false);
});

test('the digest the person approved is the digest of exactly the tools listed', async () => {
  const f = track(fixture());
  const found = await f.manager.discover('srv_1');
  assert.equal(found.digest, toolListDigest(found.tools));
  assert.ok(found.dropped > 0);
});

// ------------------------------------------------------------------ wiring ---

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

test('adding, turning on and approving tools are confirmed in a native dialog; turning off and removing are not', () => {
  const bridge = read('bridge.js');
  assert.match(bridge, /handle\('desktop:mcpAddServer', async \(input\) => \{[\s\S]*?await confirmMcp\([\s\S]*?const id = settings\.addMcpServer\(def\);/);
  assert.match(bridge, /handle\('desktop:mcpSetEnabled', async \(id, on\) => \{[\s\S]*?if \(on\) \{[\s\S]*?await confirmMcp\(/);
  assert.match(bridge, /handle\('desktop:mcpApproveTools'[\s\S]*?if \(chosen\.length\) \{\s*await confirmMcp\(/);
  const remove = bridge.slice(bridge.indexOf("handle('desktop:mcpRemoveServer'"), bridge.indexOf("handle('desktop:mcpSetEnabled'"));
  assert.doesNotMatch(remove, /confirmMcp/);
});

test('tools can only be approved from the list that was just shown', () => {
  const bridge = read('bridge.js');
  assert.match(bridge, /shown\.digest !== String\(digest \|\| ''\)/);
  assert.match(bridge, /Date\.now\(\) - shown\.at > 15 \* 60_000/);
  assert.match(bridge, /chosen\.some\(\(name\) => !shown\.names\.has\(name\)\)/);
  assert.match(bridge, /settings\.setMcpTools\(server\.id, chosen, shown\.digest\)/, 'the digest stored is the one shown, never one the page names');
});

test('the confirmation names the program, and a server is added turned off', () => {
  const bridge = read('bridge.js');
  assert.match(bridge, /describeCommandLine\(def\)/);
  assert.match(bridge, /It is added turned off/);
});

test('the page has no way to run a tool yet, and the local settings window has no way around the dialogs', () => {
  assert.doesNotMatch(read('bridge.js'), /handle\('desktop:mcpCall'/);
  assert.doesNotMatch(read('bridge.js'), /ipcMain\.handle\('settings:mcp/);
  assert.doesNotMatch(read('preload.js'), /mcpCall/);
});

test('servers are stopped when the app quits', () => {
  const main = read('main.js');
  assert.match(main, /mcpManager = bridge && bridge\.mcp;/);
  assert.match(main, /if \(mcpManager\) await mcpManager\.stopAll\(\)/);
});

test('every call is audited to an owner-only file in the app data folder', () => {
  const bridge = read('bridge.js');
  assert.match(bridge, /path\.join\(app\.getPath\('userData'\), 'mcp-audit\.jsonl'\)/);
  assert.match(bridge, /appendFileSync\(mcpAuditFile, `\$\{JSON\.stringify\(entry\)\}\\n`, \{ mode: 0o600 \}\)/);
});
