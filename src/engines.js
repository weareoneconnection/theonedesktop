'use strict';

/**
 * The coding engines on this Mac.
 *
 * The runtime is the one that answers what it can actually run — it is the
 * process that will spawn the CLI, with its PATH and its HOME. The app adds
 * the part a runtime cannot do: putting the person one click away from fixing
 * an engine that is not ready, which for Codex means its own login.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engineName } = require('./policy');

const DOCS = {
  codex: 'https://developers.openai.com/codex/cli',
  claude: 'https://docs.claude.com/en/docs/claude-code/setup',
};

// Where each installer actually puts the binary. Codex ships inside the
// ChatGPT desktop app, which is how most people on a Mac have it — and that
// copy is not on the PATH.
const CODEX_CANDIDATES = [
  path.join(os.homedir(), '.codex/bin/codex'),
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
];

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findCodexBinary(env = process.env, candidates = CODEX_CANDIDATES) {
  if (env.ONECLAW_CODEX_BIN && executable(env.ONECLAW_CODEX_BIN)) return env.ONECLAW_CODEX_BIN;
  for (const entry of String(env.PATH || '').split(':')) {
    if (!entry) continue;
    const candidate = path.join(entry, 'codex');
    if (executable(candidate)) return candidate;
  }
  return candidates.find(executable) || null;
}

/** What the app should offer for an engine that is not ready. */
function engineDocsUrl(engine) {
  return DOCS[engineName(engine)] || DOCS.claude;
}

/**
 * The engines, as the runtime that would run them reports it. When the local
 * runtime is not up there is nothing to report: saying so is better than
 * listing engines that may or may not work.
 */
async function listEngines(runtime) {
  if (!runtime || runtime.state.status !== 'ready') {
    return [
      { engine: 'theone', label: 'TheOne 引擎', ready: false, detail: '本机运行时还没启动' },
      { engine: 'claude', label: 'Claude Agent', ready: false, detail: '本机运行时还没启动' },
      { engine: 'codex', label: 'Codex', ready: false, detail: '本机运行时还没启动' },
    ];
  }
  const body = await runtime.request('GET', '/v1/code/engines').catch(() => null);
  return body && Array.isArray(body.engines) ? body.engines : [];
}

/**
 * Codex's own login, in Terminal.
 *
 * `codex login` opens a browser and waits — it has to be somewhere the person
 * can see it and finish it, and their own terminal is where their Codex
 * already lives. The app writes the command as a file and opens it, so what
 * runs is visible beforehand and nothing is typed on their behalf.
 */
function startCodexLogin({ dataDir, env = process.env, spawnFn = spawn, candidates = CODEX_CANDIDATES }) {
  const binary = findCodexBinary(env, candidates);
  if (!binary) {
    const error = new Error('这台 Mac 上没找到 Codex CLI。装好 ChatGPT 桌面版或 npm i -g @openai/codex 后再试。');
    error.code = 'codex_missing';
    throw error;
  }
  const script = path.join(dataDir, 'codex-login.command');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    script,
    [
      '#!/bin/zsh',
      '# TheOne: 登录 Codex。浏览器会打开 ChatGPT 的登录页面，完成后回到这里。',
      `echo "正在运行：${binary} login"`,
      `"${binary}" login`,
      'echo',
      'echo "完成后可以关掉这个窗口，回到 TheOne 点“重新检测”。"',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  spawnFn('/usr/bin/open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, binary, script };
}

module.exports = { CODEX_CANDIDATES, DOCS, engineDocsUrl, findCodexBinary, listEngines, startCodexLogin };
