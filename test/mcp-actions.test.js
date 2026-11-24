'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('../src/policy.js');
const { approvedToolList, callApprovedTool, MAX_EXPOSED_TOOLS } = require('../src/mcp/actions.js');
const { McpManager } = require('../src/mcp/manager.js');
const { buildChildEnv } = require('../src/mcp/config.js');
const { Settings } = require('../src/settings.js');
const { validateServerDefinition } = require('../src/mcp/config.js');
const { SUPPORTED_CAPABILITIES, KNOWN_CAPABILITIES } = require('../src/bridge-contract.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');
const ID = 'srv_0123456789ab';
const call = (action, input) => policy.localAgentCall({ action, input }, [], null);

// ------------------------------------------------------------------ policy ---

test('the MCP actions are local actions, and need neither a folder nor the terminal', () => {
  assert.ok(policy.LOCAL_AGENT_ACTIONS.has('mcp.list'));
  assert.ok(policy.LOCAL_AGENT_ACTIONS.has('mcp.call'));
  assert.deepEqual(call('mcp.list', { anything: 'x' }), { action: 'mcp.list', input: {} });
});

test('a call is rebuilt field by field: a server id, a tool name, arguments', () => {
  const built = call('mcp.call', { server: ID, tool: 'read_file', arguments: { path: 'a.txt', nested: { a: [1, 2] } }, sessionId: 'session_abc123', env: { PATH: '/x' }, command: 'rm -rf ~', approved: true });
  assert.deepEqual(built, { action: 'mcp.call', input: { server: ID, tool: 'read_file', arguments: { path: 'a.txt', nested: { a: [1, 2] } }, sessionId: 'session_abc123' } });
  assert.deepEqual(call('mcp.call', { server: ID, tool: 'x' }).input.arguments, {});
});

test('what is refused in a call', () => {
  for (const server of ['', 'srv_', 'srv_xyz', 'SRV_0123456789ab', 'srv_0123456789abc', '../srv_0123456789ab', 5]) assert.throws(() => call('mcp.call', { server, tool: 'x' }), /names a server by its id/, String(server));
  for (const tool of ['', 'a b', 'a/b', '../x', 'x'.repeat(65), 'a;b', 5]) assert.throws(() => call('mcp.call', { server: ID, tool }), /not a valid tool name/, String(tool));
  for (const arguments_ of [[], 'x', 5, null]) assert.throws(() => call('mcp.call', { server: ID, tool: 'x', arguments: arguments_ }), /must be an object/);
  assert.throws(() => call('mcp.call', { server: ID, tool: 'x', arguments: { a: 'x'.repeat(300_000) } }), /too large/);
  const circular = {}; circular.self = circular;
  assert.throws(() => call('mcp.call', { server: ID, tool: 'x', arguments: circular }), /plain JSON/);
  assert.throws(() => call('mcp.call', null), /names a server by its id/);
});

test('a session id that is not one is dropped, not passed on', () => {
  assert.equal('sessionId' in call('mcp.call', { server: ID, tool: 'x', sessionId: 'a b; rm' }).input, false);
});

test('the other local actions are unchanged', () => {
  assert.deepEqual(policy.localAgentCall({ action: 'file.read', input: { path: '/Users/me/app/a.ts', limit: 5 } }, ['/Users/me/app']), policy.localAgentCall({ action: 'file.read', input: { path: '/Users/me/app/a.ts', limit: 5 } }, ['/Users/me/app'], null));
  assert.throws(() => policy.localAgentCall({ action: 'mcp.run', input: {} }, [], null), /does not run/);
  assert.throws(() => policy.localAgentCall({ action: 'mcp.', input: {} }, [], null), /does not run/);
});

test('the bridge advertises MCP as a capability', () => {
  assert.ok(SUPPORTED_CAPABILITIES.includes('mcpV1'));
  assert.ok(KNOWN_CAPABILITIES.includes('mcpV1'));
});

// ----------------------------------------------------------- what is listed ---

const tool = (name, extra = {}) => ({ name, description: `${name} tool`, inputSchema: { type: 'object' }, ...extra });
const server = (over = {}) => ({ id: ID, name: 'files', enabled: true, approvedDigest: 'd', enabledTools: ['read', 'write'], approvedTools: [tool('read'), tool('write')], ...over });
const ok = () => ({ failed: false, changed: false });

test('the chat is offered the tools the person turned on, under names that cannot collide with built-in ones', () => {
  const { tools, servers } = approvedToolList([server()], ok);
  assert.deepEqual(tools.map((t) => t.name), ['mcp__files__read', 'mcp__files__write']);
  assert.deepEqual(tools[0], { server: ID, serverName: 'files', tool: 'read', name: 'mcp__files__read', description: 'read tool', inputSchema: { type: 'object' } });
  assert.deepEqual(servers, [{ server: ID, name: 'files', tools: 2, state: 'ready' }]);
});

test('a tool that was shown but not turned on is not offered', () => {
  const { tools } = approvedToolList([server({ enabledTools: ['read'] })], ok);
  assert.deepEqual(tools.map((t) => t.tool), ['read']);
});

test('a server that is off, not approved, failed or changed offers nothing, and says why', () => {
  const cases = [
    [server({ enabled: false }), ok, 'off'], [server({ approvedDigest: '' }), ok, 'not_approved'],
    [server(), () => ({ failed: true, changed: false }), 'failed'], [server(), () => ({ failed: false, changed: true }), 'changed'],
  ];
  for (const [s, status, state] of cases) {
    const result = approvedToolList([s], status);
    assert.deepEqual(result.tools, [], state);
    assert.equal(result.servers[0].state, state);
  }
});

test('a name that does not fit, and more than the limit, are left out', () => {
  assert.deepEqual(approvedToolList([server({ enabledTools: ['x'.repeat(60)], approvedTools: [tool('x'.repeat(60))] })], ok).tools, []);
  const many = Array.from({ length: 60 }, (_, i) => tool(`t${i}`));
  const { tools } = approvedToolList([server({ enabledTools: many.map((t) => t.name), approvedTools: many })], ok);
  assert.equal(tools.length, MAX_EXPOSED_TOOLS);
});

test('what is offered is what was stored at approval, so a server cannot rewrite it afterwards', () => {
  const stored = server({ approvedTools: [tool('read', { description: 'what the person saw' })], enabledTools: ['read'] });
  assert.equal(approvedToolList([stored], ok).tools[0].description, 'what the person saw');
});

// ---------------------------------------------------------- settings storage ---

function settingsIn() {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-act-')));
  return { settings: new Settings({ dataDir, safeStorage: { isEncryptionAvailable: () => false } }), dataDir };
}

test('only the definitions of the tools turned on are kept, and they go when the server is turned off', () => {
  const { settings } = settingsIn();
  const id = settings.addMcpServer(validateServerDefinition({ name: 'files', command: 'npx' }));
  settings.setMcpEnabled(id, true);
  settings.setMcpTools(id, ['read'], 'digest1', [tool('read'), tool('write'), tool('delete')]);
  assert.deepEqual(settings.mcpServers[0].approvedTools.map((t) => t.name), ['read']);
  assert.deepEqual(settings.mcpServers[0].enabledTools, ['read']);
  settings.setMcpEnabled(id, false);
  assert.deepEqual(settings.mcpServers[0].approvedTools, []);
});

test('a damaged definition is dropped on reading', () => {
  const { settings } = settingsIn();
  const id = settings.addMcpServer(validateServerDefinition({ name: 'files', command: 'npx' }));
  settings.updateMcpServer(id, { approvedTools: [null, 5, { name: 7 }, { name: 'ok', description: 5, inputSchema: 'x' }] });
  assert.deepEqual(settings.mcpServers[0].approvedTools, [{ name: 'ok', description: '5', inputSchema: { type: 'object' } }]);
});

// ------------------------------------------------------------------- calls ---

function live({ modes = [], digestOf } = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-call-')));
  const s = { id: ID, name: 'fake', command: process.execPath, args: [FAKE], envNames: [], enabled: true, approvedDigest: '', enabledTools: ['echo', 'fail'], approvedTools: [] };
  const manager = new McpManager({
    store: { list: () => [s], get: (id) => (id === s.id ? s : null), env: () => ({}) }, dataDir, pathValue: () => process.env.PATH, audit: () => undefined,
    limits: { requestTimeoutMs: 1500, initTimeoutMs: 1500 },
    childEnv: ({ declared, pathValue }) => ({ ...buildChildEnv({ declared, pathValue }), FAKE_MODES: modes.join(',') }),
  });
  return { manager, s, async approve() { const found = await manager.discover(ID); s.approvedDigest = found.digest; await manager.stop(ID); manager.reset(ID); } };
}
const running = [];
test.afterEach(async () => { while (running.length) await running.pop().manager.stopAll(); });

test('a call goes to the server and comes back as data', async () => {
  const f = live(); running.push(f); await f.approve();
  const result = await callApprovedTool(f.manager, { server: ID, tool: 'echo', arguments: { text: 'hi' } });
  assert.deepEqual({ status: result.status, text: result.text, outputIsData: result.outputIsData }, { status: 'ok', text: 'hi', outputIsData: true });
  const failed = await callApprovedTool(f.manager, { server: ID, tool: 'fail', arguments: {} });
  assert.deepEqual({ status: failed.status, text: failed.text }, { status: 'tool_error', text: 'it went wrong' });
});

test('a refusal is an answer the model can read, never an exception, and nothing reaches the server', async () => {
  const f = live(); running.push(f);
  const notApproved = await callApprovedTool(f.manager, { server: ID, tool: 'echo', arguments: {} });
  assert.deepEqual({ status: notApproved.status, code: notApproved.code }, { status: 'error', code: 'not_approved' });
  await f.approve();
  const notOn = await callApprovedTool(f.manager, { server: ID, tool: 'slow', arguments: {} });
  assert.equal(notOn.code, 'tool_not_enabled');
  f.s.enabled = false;
  assert.equal((await callApprovedTool(f.manager, { server: ID, tool: 'echo', arguments: {} })).code, 'disabled');
  const unknown = await callApprovedTool(f.manager, { server: 'srv_ffffffffffff', tool: 'echo', arguments: {} });
  assert.equal(unknown.code, 'unknown_server');
  assert.equal(f.manager.status(ID).running, false);
});

test('a call that outlives its deadline is reported as a timeout', async () => {
  const f = live(); running.push(f); f.s.enabledTools.push('hang'); await f.approve();
  f.manager.limits.requestTimeoutMs = 300;
  const result = await callApprovedTool(f.manager, { server: ID, tool: 'hang', arguments: {} });
  assert.deepEqual({ status: result.status, code: result.code }, { status: 'error', code: 'timeout' });
});

// ------------------------------------------------------------------ wiring ---

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

test('the page asks for an action, the policy rebuilds it, and MCP does not wait for the runtime', () => {
  const bridge = read('bridge.js');
  const handler = bridge.slice(bridge.indexOf("handleWithEvent('desktop:runAction'"), bridge.indexOf("handleWithEvent('desktop:pendingTasks'"));
  assert.match(handler, /const call = localAgentCall\(body, settings\.workspaces, settings\.terminal\);/);
  assert.ok(handler.indexOf("call.action === 'mcp.list'") > handler.indexOf('localAgentCall('), 'the request is rebuilt first');
  assert.ok(handler.indexOf("call.action === 'mcp.list'") < handler.indexOf("runtime.state.status !== 'ready'"), 'a stopped runtime does not stop MCP');
  assert.match(handler, /return runMcpAction\(call\);/);
});

test('the definitions stored are the ones that were shown, taken from the listing and not from the page', () => {
  const bridge = read('bridge.js');
  assert.match(bridge, /tools: found\.tools, at: Date\.now\(\)/);
  assert.match(bridge, /settings\.setMcpTools\(server\.id, chosen, shown\.digest, shown\.tools\)/);
});
