'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpConnection, McpError } = require('../src/mcp/client.js');
const sanitize = require('../src/mcp/sanitize.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');
const open = [];
function connection(modes = [], extra = {}, env = {}) {
  const conn = new McpConnection({
    command: process.execPath, args: [FAKE], cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, FAKE_MODES: modes.join(','), ...env },
    initTimeoutMs: 1500, requestTimeoutMs: 1500, ...extra,
  });
  open.push(conn);
  return conn;
}
test.afterEach(async () => { while (open.length) await open.pop().close(); });
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-')), name);
const rejectsWith = async (promise, code) => {
  await assert.rejects(promise, (error) => { assert.ok(error instanceof McpError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

test('a well-behaved server: handshake, list, call', async () => {
  const conn = await connection().start();
  assert.ok(conn.alive);
  assert.equal(conn.protocolVersion, '2025-06-18');
  const { tools, dropped } = await conn.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['big', 'child', 'crash', 'cwd', 'echo', 'env', 'fail', 'hang', 'image', 'leak', 'slow'].sort());
  assert.ok(dropped >= 3, 'invalid names, schemas that are too large or not objects are dropped');
  const result = await conn.callTool('echo', { text: 'hello' });
  assert.deepEqual({ text: result.text, isError: result.isError }, { text: 'hello', isError: false });
});

test('the server\'s name is cleaned, and its own annotations are not carried', async () => {
  const conn = await connection().start();
  assert.equal(conn.serverInfo.name, 'fake server');
  const { tools } = await conn.listTools();
  const echo = tools.find((t) => t.name === 'echo');
  assert.equal('annotations' in echo, false);
  assert.deepEqual(Object.keys(echo).sort(), ['description', 'inputSchema', 'name']);
});

test('descriptions are data: control and invisible characters are removed and the length is bounded', async () => {
  const conn = await connection(['poison']).start();
  const echo = (await conn.listTools()).tools.find((t) => t.name === 'echo');
  assert.doesNotMatch(echo.description, /[\u0000-\u001f‮]/);
  assert.ok(echo.description.length <= 1000);
  assert.equal(echo.inputSchema.properties.text.description, 'text to echo');
  // The injection text is still just text: nothing here can act on it.
  assert.match(echo.description, /IGNORE ALL PREVIOUS INSTRUCTIONS/);
});

test('pagination is followed, a repeated name is contradictory and unused', async () => {
  const paged = await connection(['pages']).start();
  assert.ok((await paged.listTools()).tools.length >= 8);
  const dup = await connection(['duplicate']).start();
  const { tools } = await dup.listTools();
  assert.equal(tools.some((t) => t.name === 'echo'), false);
});

test('a tool list that is not a list is refused', async () => {
  const conn = await connection(['notalist']).start();
  await rejectsWith(conn.listTools(), 'bad_response');
});

test('the tool limit is enforced', async () => {
  const conn = await connection([], { maxTools: 3 }).start();
  const { tools, dropped } = await conn.listTools();
  assert.equal(tools.length, 3);
  assert.ok(dropped > 0);
});

test('an unsupported protocol version, or no tools, fails the handshake and leaves nothing running', async () => {
  const bad = connection(['badversion']);
  await rejectsWith(bad.start(), 'unsupported_protocol');
  assert.equal(bad.alive, false);
  const none = connection(['notools']);
  await rejectsWith(none.start(), 'no_tools');
  assert.equal(none.alive, false);
});

test('a server that never answers the handshake times out', async () => {
  const conn = connection(['noinit'], { initTimeoutMs: 300 });
  await rejectsWith(conn.start(), 'timeout');
  assert.equal(conn.alive, false);
});

test('a program that is not there fails to start with a clear error', async () => {
  const conn = new McpConnection({ command: '/no/such/program', args: [], cwd: os.tmpdir(), env: {}, initTimeoutMs: 500 });
  await rejectsWith(conn.start(), 'spawn_failed');
});

test('a call that is never answered times out, and the server is told to stop working on it', async () => {
  const log = tmp('log');
  const conn = await connection([], {}, { FAKE_LOG: log }).start();
  await rejectsWith(conn.callTool('hang', {}, { timeoutMs: 300 }), 'timeout');
  await new Promise((r) => setTimeout(r, 200));
  assert.match(fs.readFileSync(log, 'utf8'), /cancelled \d+ timeout/);
  assert.ok(conn.alive, 'a slow call does not end the server');
  assert.equal((await conn.callTool('echo', { text: 'still here' })).text, 'still here');
});

test('an abort signal cancels a call', async () => {
  const log = tmp('log');
  const conn = await connection([], {}, { FAKE_LOG: log }).start();
  const controller = new AbortController();
  const pending = conn.callTool('hang', {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await rejectsWith(pending, 'cancelled');
  await rejectsWith(conn.callTool('echo', { text: 'x' }, { signal: controller.signal }), 'cancelled');
  await new Promise((r) => setTimeout(r, 200));
  assert.match(fs.readFileSync(log, 'utf8'), /cancelled \d+ cancelled by the user/);
});

test('a server that dies mid-call rejects the call and is reported', async () => {
  let exit = null;
  const conn = await connection([], { onExit: (info) => { exit = info; } }).start();
  await rejectsWith(conn.callTool('crash', {}), 'server_exited');
  assert.equal(conn.alive, false);
  assert.equal(exit.code, 3);
  assert.equal(exit.closing, false);
  await rejectsWith(conn.callTool('echo', { text: 'x' }), 'not_running');
});

test('a server that talks nonsense is stopped', async () => {
  const conn = connection(['badjson']);
  // The noise comes first and the handshake never completes: it is closed for it.
  await assert.rejects(conn.start());
  assert.equal(conn.alive, false);
});

test('a message larger than the limit stops the server', async () => {
  const conn = connection(['hugeline']);
  await assert.rejects(conn.start());
  assert.equal(conn.alive, false);
  assert.match(conn.violationReason || '', /larger than the limit/);
});

test('a reply to something we never asked is ignored', async () => {
  const conn = await connection(['unsolicited']).start();
  assert.equal((await conn.callTool('echo', { text: 'ok' })).text, 'ok');
});

test('the server may ping us, and is told no to anything else (we offered it nothing)', async () => {
  const log = tmp('log');
  const conn = await connection(['serverreq'], {}, { FAKE_LOG: log }).start();
  await conn.callTool('echo', { text: 'x' });
  await new Promise((r) => setTimeout(r, 200));
  const text = fs.readFileSync(log, 'utf8');
  assert.match(text, /reply srv-1 \{\}/);
  assert.match(text, /error srv-2 -32601/);
});

test('a list-changed notice is noticed', async () => {
  let notified = 0;
  const conn = await connection(['listchanged'], { onToolsChanged: () => { notified += 1; } }).start();
  await conn.callTool('echo', { text: 'x' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(notified, 1);
  assert.equal(conn.toolsChanged, true);
  await conn.listTools();
  assert.equal(conn.toolsChanged, false);
});

test('results: errors are flagged, pictures and resources are named but not shown', async () => {
  const conn = await connection().start();
  const failed = await conn.callTool('fail', {});
  assert.deepEqual({ text: failed.text, isError: failed.isError }, { text: 'it went wrong', isError: true });
  const picture = await conn.callTool('image', {});
  assert.match(picture.text, /^see picture/);
  assert.match(picture.text, /\[not shown: 1 image, 1 resource\]/);
  assert.doesNotMatch(picture.text, /AAAA|secret/);
});

test('results are cut at the limit, keeping the end', async () => {
  const conn = await connection().start();
  const big = await conn.callTool('big', {});
  assert.equal(big.truncated, true);
  assert.ok(big.text.length < 31_000);
  assert.match(big.text, /THE-END$/);
});

test('secrets in a result are masked', async () => {
  const conn = await connection().start();
  const { text } = await conn.callTool('leak', {});
  assert.doesNotMatch(text, /hunter2hunter2|ghp_abcdefghijklmnopqrstuv|abc\.def\.ghi/);
  assert.match(text, /REDACTED/);
});

test('arguments must be a plain object of a sane size, and a tool name must be well-formed', async () => {
  const conn = await connection().start();
  await rejectsWith(conn.callTool('echo', 'text'), 'bad_request');
  await rejectsWith(conn.callTool('echo', [1]), 'bad_request');
  await rejectsWith(conn.callTool('echo', null), 'bad_request');
  await rejectsWith(conn.callTool('echo', { text: 'x'.repeat(300_000) }), 'bad_request');
  await rejectsWith(conn.callTool('bad name!', {}), 'bad_request');
  await rejectsWith(conn.callTool('../etc', {}), 'bad_request');
  const circular = {}; circular.self = circular;
  await rejectsWith(conn.callTool('echo', circular), 'bad_request');
});

test('an unknown tool is the server\'s error, not ours', async () => {
  const conn = await connection().start();
  await rejectsWith(conn.callTool('nope', {}), 'server_error');
});

test('closing ends the server and everything it started', async () => {
  const pidFile = tmp('child.pid');
  const conn = await connection([], {}, { FAKE_CHILD_PID: pidFile }).start();
  await conn.callTool('child', {});
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(childPid > 1);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(childPid));
  await conn.close();
  let gone = false;
  for (let i = 0; i < 40 && !gone; i += 1) { gone = !alive(childPid); if (!gone) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(gone, 'the background process is gone too');
  assert.equal(conn.alive, false);
});

test('closing twice, or a server that is already gone, is fine', async () => {
  const conn = await connection().start();
  await Promise.all([conn.close(), conn.close()]);
  await conn.close();
});

// ----------------------------------------------------------------- sanitize ---

test('tool names: only plain ones, and only if the exposed name fits', () => {
  for (const name of ['a', 'read_file', 'get.thing-2', 'A'.repeat(64)]) assert.ok(sanitize.normalizeTool({ name, inputSchema: { type: 'object' } }), name);
  for (const name of ['', 'a b', 'a/b', 'a;b', '../x', 'é', 'A'.repeat(65), 5, null]) assert.equal(sanitize.normalizeTool({ name, inputSchema: { type: 'object' } }), null, String(name));
  assert.equal(sanitize.exposedToolName('fs', 'read'), 'mcp__fs__read');
  assert.equal(sanitize.exposedToolName('fs', 'x'.repeat(60)), null);
  assert.equal(sanitize.exposedToolName('Bad Name', 'read'), null);
  assert.equal(sanitize.exposedToolName('fs', 'a b'), null);
});

test('schemas must be objects of a bounded size', () => {
  assert.equal(sanitize.normalizeTool({ name: 'a', inputSchema: [] }), null);
  assert.equal(sanitize.normalizeTool({ name: 'a', inputSchema: { type: 'string' } }), null);
  assert.equal(sanitize.normalizeTool({ name: 'a', inputSchema: { type: 'object', properties: { x: { type: 'string', description: 'y'.repeat(30_000) } } } }), null);
  assert.deepEqual(sanitize.normalizeTool({ name: 'a' }).inputSchema, { type: 'object', properties: {} });
});

test('the digest changes with a name, a description or a schema, and not with key order or list order', () => {
  const a = { name: 'a', description: 'one', inputSchema: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } } } };
  const b = { name: 'b', description: 'two', inputSchema: { type: 'object' } };
  const base = sanitize.toolListDigest([a, b]);
  assert.equal(base, sanitize.toolListDigest([b, a]));
  assert.equal(base, sanitize.toolListDigest([{ ...a, inputSchema: { properties: { y: { type: 'number' }, x: { type: 'string' } }, type: 'object' } }, b]));
  assert.notEqual(base, sanitize.toolListDigest([{ ...a, description: 'one!' }, b]));
  assert.notEqual(base, sanitize.toolListDigest([{ ...a, name: 'a2' }, b]));
  assert.notEqual(base, sanitize.toolListDigest([{ ...a, inputSchema: { type: 'object', properties: { x: { type: 'number' } } } }, b]));
  assert.notEqual(base, sanitize.toolListDigest([a]));
});
