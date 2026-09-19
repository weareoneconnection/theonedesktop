'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('an analysis task asks the runtime for a report, not a change', () => {
  const { buildLocalTaskInput } = require('../src/policy');
  const picked = ['/Users/me/app'];
  assert.deepEqual(
    buildLocalTaskInput({ objective: '分析如何升级此代码', workspacePath: '/Users/me/app', analyze: true, attempts: 3, isolate: true, verify: 'npm test' }, picked),
    { objective: '分析如何升级此代码', workspacePath: '/Users/me/app', analyze: true },
  );
  // A folder the person never opened is still refused.
  assert.throws(() => buildLocalTaskInput({ objective: '分析这个目录的结构', workspacePath: '/etc', analyze: true }, picked));
});

test('checks a note sent to a running task', () => {
  const { steeringMessage } = require('../src/policy');
  assert.equal(steeringMessage('  别装依赖了  '), '别装依赖了');
  assert.throws(() => steeringMessage('   '));
  assert.throws(() => steeringMessage('x'.repeat(2001)));
});

test('an engine choice reaches the runtime, and the default does not', () => {
  const picked = policy.buildLocalTaskInput({ objective: '修复分页测试的边界问题', workspacePath: '/tmp/repo', engine: 'codex' }, ['/tmp/repo']);
  assert.equal(picked.engine, 'codex');
  const builtIn = policy.buildLocalTaskInput({ objective: '修复分页测试的边界问题', workspacePath: '/tmp/repo', engine: 'theone' }, ['/tmp/repo']);
  assert.ok(!('engine' in builtIn));
  // An analysis task keeps its engine too.
  const analysis = policy.buildLocalTaskInput({ objective: '分析构建流程', workspacePath: '/tmp/repo', analyze: true, engine: 'claude' }, ['/tmp/repo']);
  assert.deepEqual(analysis, { objective: '分析构建流程', workspacePath: '/tmp/repo', engine: 'claude', analyze: true });
});

test('a short Chinese objective is a whole instruction', () => {
  // Eight characters is two English words; "修复分页测试" is already clear.
  assert.equal(policy.objectiveTooShort('修复分页测试'), false);
  assert.equal(policy.objectiveTooShort('fix it'), true);
  assert.equal(policy.objectiveTooShort('   '), true);
  assert.doesNotThrow(() => policy.buildLocalTaskInput({ objective: '修复分页测试', workspacePath: '/tmp/repo' }, ['/tmp/repo']));
});

test('an engine that is not ready gets the one action that would fix it', () => {
  assert.deepEqual(policy.engineAction({ engine: 'codex', ready: true }), { engine: 'codex', action: 'none' });
  assert.deepEqual(
    policy.engineAction({ engine: 'codex', ready: false, detail: '已安装，但还没登录：在终端运行 codex login' }),
    { engine: 'codex', action: 'login' },
  );
  assert.deepEqual(
    policy.engineAction({ engine: 'codex', ready: false, detail: '未找到 Codex CLI（安装 ChatGPT 桌面版或 npm i -g @openai/codex）' }),
    { engine: 'codex', action: 'install' },
  );
  assert.deepEqual(
    policy.engineAction({ engine: 'claude', ready: false, detail: '已安装，但需要你的 Anthropic API 密钥' }),
    { engine: 'claude', action: 'key' },
  );
});

test('codex login runs the binary this Mac actually has, in a file you can read first', () => {
  const engines = require('../src/engines');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-engines-'));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-bin-'));
  const binary = path.join(binDir, 'codex');
  fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });

  const calls = [];
  const spawnFn = (command, args) => { calls.push([command, args]); return { unref() {} }; };
  const result = engines.startCodexLogin({ dataDir, env: { PATH: binDir }, spawnFn });

  assert.equal(result.binary, binary);
  assert.equal(calls[0][0], '/usr/bin/open');
  assert.deepEqual(calls[0][1], ['-a', 'Terminal', result.script]);
  const script = fs.readFileSync(result.script, 'utf8');
  assert.ok(script.includes(`"${binary}" login`));
  // Nothing is typed on the person's behalf; the script only runs the login.
  assert.ok(!script.includes('--with-api-key'));

  // An explicit override wins over both the PATH and the known locations.
  const override = path.join(binDir, 'codex-beta');
  fs.writeFileSync(override, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(engines.findCodexBinary({ ONECLAW_CODEX_BIN: override, PATH: binDir }), override);
  // On a Mac that has Codex only inside ChatGPT.app, that copy is found.
  assert.equal(engines.findCodexBinary({ PATH: '/nonexistent' }, [binary]), binary);

  assert.throws(
    () => engines.startCodexLogin({ dataDir, env: { PATH: '/nonexistent' }, spawnFn, candidates: [] }),
    /没找到 Codex CLI/,
  );
});

test('the engines this Mac has are reported by the runtime that would run them', async () => {
  const engines = require('../src/engines');
  const stopped = await engines.listEngines({ state: { status: 'stopped' } });
  assert.deepEqual(stopped.map((item) => item.ready), [false, false, false]);
  assert.ok(stopped[0].detail.includes('运行时'));

  const ready = await engines.listEngines({
    state: { status: 'ready' },
    request: async (method, path) => {
      assert.equal(method, 'GET');
      assert.equal(path, '/v1/code/engines');
      return { engines: [{ engine: 'codex', ready: true, detail: '已就绪' }] };
    },
  });
  assert.deepEqual(ready, [{ engine: 'codex', ready: true, detail: '已就绪' }]);
});

test('files handed to a local run travel with it, within the runtime limits', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const input = policy.buildLocalTaskInput({
    objective: '按这张截图修一下按钮位置',
    workspacePath: '/tmp/repo',
    attachments: [{ name: '错误截图.png', content: `data:image/png;base64,${png}` }],
  }, ['/tmp/repo']);
  assert.equal(input.attachments.length, 1);
  assert.equal(input.attachments[0].name, '错误截图.png');

  // The caps are the runtime's, so the app refuses the same things it would.
  assert.throws(() => policy.localAttachments(Array(7).fill({ name: 'a.png', content: png })), /最多带 6 个/);
  assert.throws(() => policy.localAttachments([{ name: 'a.png' }]), /缺少文件名或内容/);
  assert.throws(() => policy.localAttachments([{ name: 'big.bin', content: 'A'.repeat(12 * 1024 * 1024) }]), /太大/);
  assert.deepEqual(policy.localAttachments(undefined), []);
});

test('a big local task can ask for more turns, within range', () => {
  const input = policy.buildLocalTaskInput({ objective: '升级全部依赖并修好构建', workspacePath: '/tmp/repo', maxTurns: 120 }, ['/tmp/repo']);
  assert.equal(input.maxTurns, 120);
  for (const bad of [5, 500, 1.5]) {
    assert.throws(() => policy.buildLocalTaskInput({ objective: '升级全部依赖并修好构建', workspacePath: '/tmp/repo', maxTurns: bad }, ['/tmp/repo']), /between 10 and 200/);
  }
});

test('a local task can name the Claude model it runs on', () => {
  const picked = ['/Users/me/code/app'];
  const base = { objective: 'fix the failing login test', workspacePath: '/Users/me/code/app' };
  assert.equal(policy.buildLocalTaskInput({ ...base, model: 'claude-opus-5' }, picked).model, 'claude-opus-5');
  assert.equal(policy.buildLocalTaskInput({ ...base, engine: 'claude', model: 'claude-fable-5-1' }, picked).model, 'claude-fable-5-1');
  assert.equal(policy.buildLocalTaskInput({ ...base, analyze: true, model: 'claude-opus-5' }, picked).model, 'claude-opus-5');
  // Empty means the engine default: nothing is sent.
  assert.equal('model' in policy.buildLocalTaskInput({ ...base, model: '' }, picked), false);
  // Codex runs OpenAI models; a Claude model is dropped rather than passed on.
  assert.equal('model' in policy.buildLocalTaskInput({ ...base, engine: 'codex', model: 'claude-opus-5' }, picked), false);
  // It becomes a CLI flag, so nothing outside the list gets through.
  assert.throws(() => policy.buildLocalTaskInput({ ...base, engine: 'claude', model: '--settings /tmp/x' }, picked), /Unknown model/);
});
