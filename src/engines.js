'use strict';

/**
 * The coding engines on this computer.
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
const { installedCodexPath } = require('./codex-install');
const { delimiter, executableNames } = require('./platform');

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
  // Current ChatGPT builds keep the CLI in Resources/codex-cli/bin; older
  // ones put it straight in Resources. Both are looked for.
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
  // Windows: the exe inside an `npm install -g @openai/codex`. Not npm's
  // codex.cmd shim: the runtime spawns Codex without a shell, and a .cmd
  // cannot run that way.
  ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')] : []),
];

function executable(file) {
  try {
    // Windows has no execute bit: the file being there is the test.
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Codex, in order: an explicit override, the copy TheOne installed (a pinned,
 * tested version: codex-install.js), the PATH, then the known install places.
 */
function findCodexBinary(env = process.env, candidates = CODEX_CANDIDATES, installed = null) {
  if (env.ONECLAW_CODEX_BIN && executable(env.ONECLAW_CODEX_BIN)) return env.ONECLAW_CODEX_BIN;
  if (installed && executable(installed)) return installed;
  for (const entry of String(env.PATH || env.Path || '').split(delimiter())) {
    if (!entry) continue;
    // Windows: only codex.exe (see CODEX_CANDIDATES on .cmd shims).
    const names = executableNames('codex', process.platform, env).filter((name) => process.platform !== 'win32' || name.endsWith('.exe'));
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (executable(candidate)) return candidate;
    }
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
  const binary = findCodexBinary(env, candidates, installedCodexPath(dataDir));
  if (!binary) {
    const error = new Error('这台电脑上还没有 Codex。先点“安装 Codex”，装好后再登录。');
    error.code = 'codex_missing';
    throw error;
  }
  if (process.platform === 'win32') {
    // Windows: a .cmd in its own console window, readable before it runs.
    const script = path.join(dataDir, 'codex-login.cmd');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(script, [
      '@echo off',
      'rem TheOne: sign in to Codex. A browser opens the ChatGPT sign-in; come back here when done.',
      `echo Running: "${binary}" login`,
      `"${binary}" login`,
      'echo.',
      'echo Done. Close this window and click "Check again" in TheOne.',
      'pause',
      '',
    ].join('\r\n'));
    spawnFn('cmd.exe', ['/c', 'start', '""', script], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { ok: true, binary, script };
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
