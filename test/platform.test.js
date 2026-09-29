'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executableNames, fallbackPath, gitBash, mergePath, systemEnv, windowChrome, workspaceRoots } = require('../src/platform');

test('the Mac keeps its inset title bar; Windows keeps its own frame', () => {
  assert.equal(windowChrome('darwin').titleBarStyle, 'hiddenInset');
  assert.equal(windowChrome('win32').titleBarStyle, undefined);
  assert.equal(windowChrome('win32').autoHideMenuBar, true);
});

test('PATH merges with the platform separator, Windows ignoring case', () => {
  assert.equal(mergePath('darwin', '/a:/b', '/b:/c'), '/a:/b:/c');
  assert.equal(mergePath('win32', 'C:\\Git\\cmd;C:\\Node', 'c:\\git\\cmd;C:\\Tools'), 'C:\\Git\\cmd;C:\\Node;C:\\Tools');
});

test('the fallback PATH has Git and Node on Windows', () => {
  const win = fallbackPath('win32', { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' });
  assert.match(win, /Git\\cmd/);
  assert.match(win, /nodejs/);
  assert.ok(fallbackPath('darwin').startsWith('/opt/homebrew/bin:'));
});

test('Git Bash is found where Git for Windows puts it, or reported missing', () => {
  const env = { ProgramFiles: 'C:\\Program Files' };
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(gitBash(env, (file) => file === bash), bash);
  assert.equal(gitBash(env, () => false), null);
});

test('workspace roots are every drive on Windows and / on the Mac', () => {
  assert.equal(workspaceRoots('darwin'), '/');
  assert.equal(workspaceRoots('win32', (root) => root === 'C:\\' || root === 'D:\\'), 'C:\\,D:\\');
});

test('Windows children get the system variables; the Mac gets none extra', () => {
  assert.deepEqual(systemEnv('darwin', { SystemRoot: 'x' }), {});
  assert.deepEqual(systemEnv('win32', { SystemRoot: 'C:\\Windows', SECRET: 'no' }), { SystemRoot: 'C:\\Windows' });
});

test('executables are looked for with Windows extensions', () => {
  assert.deepEqual(executableNames('codex', 'darwin'), ['codex']);
  assert.deepEqual(executableNames('codex', 'win32', { PATHEXT: '.EXE;.CMD' }), ['codex.exe', 'codex.cmd']);
});
