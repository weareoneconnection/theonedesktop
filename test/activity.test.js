'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readActivity, tailLines, TAIL_BYTES } = require('../src/activity');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'activity-test-'));
const write = (dir, name, lines) => { const file = path.join(dir, name); fs.writeFileSync(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`); return file; };

test('the three records are merged, newest first, in plain words', () => {
  const dir = tmp();
  const terminalAudit = write(dir, 't.jsonl', [
    { at: '2026-11-25T01:00:00.000Z', command: 'git status', workspace: '/p', decision: 'auto', exitCode: 0, elapsedMs: 12 },
    { at: '2026-11-25T03:00:00.000Z', command: 'rm -rf /', workspace: '/p', decision: 'deny', tier: 'deny' },
  ]);
  const mcpAudit = write(dir, 'm.jsonl', [{ at: '2026-11-25T02:00:00.000Z', server: 'files', tool: 'read_file', outcome: 'ok', argsPreview: '{"path":"/a"}', ms: 5 }]);
  const computerLog = write(dir, 'c.jsonl', [{ id: 'x', at: Date.UTC(2026, 10, 25, 4), app: 'Notes', kind: 'screenshot' }]);
  const rows = readActivity({ terminalAudit, mcpAudit, computerLog });
  assert.deepEqual(rows.map((row) => row.source), ['computer', 'terminal', 'mcp', 'terminal']);
  assert.deepEqual(rows.map((row) => row.outcome), ['ok', 'refused', 'ok', 'ok']);
  assert.equal(rows[2].title, 'files › read_file');
  assert.equal(rows[1].title, 'rm -rf /');
});

test('a failed command and a failed tool say so', () => {
  const dir = tmp();
  const terminalAudit = write(dir, 't.jsonl', [{ at: '2026-11-25T01:00:00.000Z', command: 'npm test', exitCode: 1 }]);
  const mcpAudit = write(dir, 'm.jsonl', [{ at: '2026-11-25T01:00:01.000Z', server: 's', tool: 't', outcome: 'tool_error' }, { at: '2026-11-25T01:00:02.000Z', server: 's', tool: 't', outcome: 'changed' }]);
  assert.deepEqual(readActivity({ terminalAudit, mcpAudit }).map((row) => row.outcome), ['refused', 'failed', 'failed']);
});

test('anything that looks like a credential is hidden, and control characters are removed', () => {
  const dir = tmp();
  const terminalAudit = write(dir, 't.jsonl', [{ at: '2026-11-25T01:00:00.000Z', command: 'curl -H "x: sk-abcdefghijklmnopqrstuv" https://a.b\u0007\u001b[31m', exitCode: 0 }]);
  const [row] = readActivity({ terminalAudit });
  assert.doesNotMatch(row.title, /sk-abcdefghijkl/);
  assert.match(row.title, /\[hidden\]/);
  assert.doesNotMatch(row.title, /[\u0000-\u0008\u001b]/);
});

test('a command is shown short, never in full', () => {
  const dir = tmp();
  const terminalAudit = write(dir, 't.jsonl', [{ at: '2026-11-25T01:00:00.000Z', command: `echo ${'x'.repeat(5000)}`, exitCode: 0 }]);
  assert.ok(readActivity({ terminalAudit })[0].title.length <= 300);
});

test('missing files, torn lines and non-objects are skipped, not fatal', () => {
  const dir = tmp();
  const terminalAudit = write(dir, 't.jsonl', ['{"at":"2026-11-25T01:00:00.000Z","command":"ls","exitCode":0}', '{"at":"2026-11-25T01:0', 'null', '[1]', '5']);
  assert.equal(readActivity({ terminalAudit, mcpAudit: path.join(dir, 'nope.jsonl'), computerLog: undefined }).length, 1);
  assert.deepEqual(readActivity({}), []);
});

test('entries without a usable time or title are dropped', () => {
  const dir = tmp();
  const terminalAudit = write(dir, 't.jsonl', [{ command: 'ls' }, { at: 'nonsense', command: 'ls' }, { at: '2026-11-25T01:00:00.000Z', command: '' }]);
  assert.deepEqual(readActivity({ terminalAudit }), []);
});

test('only the end of a large file is read, and the half line at its start is not a record', () => {
  const dir = tmp();
  const lines = Array.from({ length: 6000 }, (_, i) => ({ at: new Date(Date.UTC(2026, 10, 25, 0, 0, i)).toISOString(), command: `cmd ${i}`, exitCode: 0 }));
  const terminalAudit = write(dir, 't.jsonl', lines);
  assert.ok(fs.statSync(terminalAudit).size > TAIL_BYTES);
  const read = tailLines(terminalAudit);
  assert.ok(read.length < lines.length);
  for (const line of read) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(readActivity({ terminalAudit, limit: 1 })[0].title, 'cmd 5999');
});

test('the limit is bounded', () => {
  const dir = tmp();
  const terminalAudit = write(dir, 't.jsonl', Array.from({ length: 300 }, (_, i) => ({ at: new Date(Date.UTC(2026, 10, 25, 0, 0, i)).toISOString(), command: `c${i}`, exitCode: 0 })));
  assert.equal(readActivity({ terminalAudit, limit: 5 }).length, 5);
  assert.equal(readActivity({ terminalAudit, limit: 100000 }).length, 100);
  assert.equal(readActivity({ terminalAudit, limit: 'x' }).length, 50);
});

test('the control center only reads, and the off switch asks nothing and restarts nothing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
  const start = source.indexOf("handle('desktop:controlCenter'");
  const end = source.indexOf('const computer = {', start);
  const block = source.slice(start, end);
  assert.match(block, /handle\('desktop:disableAllLocal'/);
  // Turning things off is the safe direction: no dialog and no runtime restart (which a running task would block).
  assert.doesNotMatch(block, /confirmMcp|dialog\.|restartRuntime|assertNoRunningWork/);
  for (const off of ['settings.setTerminalEnabled(false)', 'settings.setMcpEnabled(server.id, false)', 'settings.setComputerEnabled(false)', 'computerSessions.stopAll()']) assert.ok(block.includes(off), off);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.match(preload, /controlCenter: \(limit\) => ipcRenderer\.invoke\('desktop:controlCenter', limit\)/);
  assert.match(preload, /disableAllLocal: \(\) => ipcRenderer\.invoke\('desktop:disableAllLocal'\)/);
});
