'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/policy');

test('only TheOne origins get the bridge', () => {
  const env = {};
  assert.equal(policy.isAllowedOrigin('https://theone-eta.vercel.app/os?task=1', env), true);
  assert.equal(policy.isAllowedOrigin('https://evil.example/os', env), false);
  assert.equal(policy.isAllowedOrigin('https://theone-eta.vercel.app.evil.example/', env), false);
  assert.equal(policy.isAllowedOrigin('file:///etc/passwd', env), false);
  assert.equal(policy.isAllowedOrigin('http://localhost:3017/os', env), false);
  assert.equal(policy.isAllowedOrigin('http://localhost:3017/os', { THEONE_DESKTOP_URL: 'http://localhost:3017/os' }), true);
});

test('deep links map to TheOne views and nothing else', () => {
  assert.equal(policy.deepLinkPath('theone://task/abc_123'), '/os?task=abc_123');
  assert.equal(policy.deepLinkPath('theone://code/new'), '/os?code=new');
  assert.equal(policy.deepLinkPath('theone://task/..%2F..%2Fetc'), '/os');
  assert.equal(policy.deepLinkPath('https://theone-eta.vercel.app'), null);
});

test('local task ids round-trip and reject anything else', () => {
  assert.equal(policy.fromLocalId(policy.toLocalId('Ab12_cd')), 'Ab12_cd');
  assert.throws(() => policy.fromLocalId('local:../../x'), /invalid/);
});

test('a local task must target a folder the person opened', () => {
  const picked = ['/Users/me/code/app'];
  const input = policy.buildLocalTaskInput({ objective: 'fix the failing login test', workspacePath: '/Users/me/code/app', isolate: true, attempts: 2, verify: 'npm test' }, picked);
  assert.deepEqual(input, { objective: 'fix the failing login test', workspacePath: '/Users/me/code/app', isolate: true, attempts: 2, verify: 'npm test' });
  assert.throws(() => policy.buildLocalTaskInput({ objective: 'read my keys please', workspacePath: '/Users/me/.ssh' }, picked), /not opened/);
  assert.throws(() => policy.buildLocalTaskInput({ objective: 'escape the folder', workspacePath: '/Users/me/code/app/../../.ssh' }, picked), /not opened/);
  assert.throws(() => policy.buildLocalTaskInput({ objective: 'two tries in place', workspacePath: '/Users/me/code/app', attempts: 2 }, picked), /copy/);
});

test('compact task keeps what the task view shows and marks the id local', () => {
  const task = policy.compactTask({ id: 'T1abc', status: 'success', logs: ['a'], steps: [{ stepId: 's', action: 'code.patch.apply', status: 'success', output: { verifyPassed: true, keptAttempt: 2, attempts: [{ attempt: 1 }], diff: '+x' } }] });
  assert.equal(task.id, 'local:T1abc');
  assert.equal(task.steps[0].output.verifyPassed, true);
  assert.equal(task.steps[0].output.keptAttempt, 2);
});

test('PATH merges the login shell first, without duplicates', () => {
  assert.equal(policy.mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin', policy.FALLBACK_PATH).split(':')[0], '/opt/homebrew/bin');
  assert.equal(new Set(policy.mergePath('/a:/a', '/a').split(':')).size, 1);
});

test('API key shape', () => {
  assert.equal(policy.looksLikeAnthropicKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(policy.looksLikeAnthropicKey('hello'), false);
});

test('sends a sign-in start to the browser and keeps where to come back to', () => {
  const env = {};
  assert.equal(policy.signInStart('https://theone-eta.vercel.app/api/auth/github?returnTo=%2Fos%3Ftask%3Dabc', env), '/os?task=abc');
  assert.equal(policy.signInStart('https://theone-eta.vercel.app/api/auth/github', env), '/os');
  assert.equal(policy.signInStart('https://theone-eta.vercel.app/api/auth/github?returnTo=https://evil.example', env), '/os');
  assert.equal(policy.signInStart('https://theone-eta.vercel.app/api/auth/github/callback?code=x', env), null);
  assert.equal(policy.signInStart('https://evil.example/api/auth/github', env), null);
  assert.equal(policy.signInStart('https://github.com/login', env), null);
});

test('reads only a well-formed theone://auth code', () => {
  const code = 'a'.repeat(43);
  assert.equal(policy.authLinkCode(`theone://auth?code=${code}&returnTo=%2Fos`), code);
  assert.equal(policy.authLinkCode('theone://auth?code=short'), null);
  assert.equal(policy.authLinkCode(`theone://task?code=${code}`), null);
  assert.equal(policy.authLinkCode(`https://auth?code=${code}`), null);
  assert.equal(policy.deepLinkPath(`theone://auth?code=${code}`), null);
});

test('the challenge is the SHA-256 of a verifier that stays in the app', () => {
  const crypto = require('node:crypto');
  const { verifier, challenge } = policy.signInPair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(policy.signInPair().verifier, verifier);
});

test('updates run only in the packaged app and can be switched off', () => {
  const { updatesEnabled } = require('../src/policy');
  assert.equal(updatesEnabled({ isPackaged: false, env: {} }), false);
  assert.equal(updatesEnabled({ isPackaged: true, env: {} }), true);
  assert.equal(updatesEnabled({ isPackaged: true, env: { THEONE_DESKTOP_DISABLE_UPDATES: '1' } }), false);
});

test('the update menu item follows the updater', () => {
  const { updateMenuItem } = require('../src/policy');
  assert.deepEqual(updateMenuItem({ status: 'ready', version: '0.3.0' }), { label: '重启以更新到 0.3.0', action: 'install', enabled: true });
  assert.equal(updateMenuItem({ status: 'downloading', version: '0.3.0', progress: 42 }).label, '正在下载 0.3.0（42%）');
  assert.equal(updateMenuItem({ status: 'idle' }).action, 'check');
  assert.equal(updateMenuItem({ status: 'error' }).action, 'check');
  assert.equal(updateMenuItem({ status: 'disabled' }).enabled, false);
});
