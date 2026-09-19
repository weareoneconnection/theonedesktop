'use strict';

/**
 * The local OneClaw runtime: the same agent engine the cloud runs, started by
 * the app and reachable only from this Mac.
 *
 * - bound to 127.0.0.1 on a free port, with a random token only the main
 *   process holds (the page never sees it)
 * - no database: tasks live in memory for the life of the app
 * - its environment is built from scratch, never inherited, so nothing from the
 *   shell that launched the app (cloud credentials, database URLs) leaks in
 * - its working directory is the app's own data folder, so no stray .env is read
 */

const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { FALLBACK_PATH, codexEnv, mergePath } = require('./policy');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The login shell's PATH, or '' if it cannot be read quickly. */
function loginShellPath() {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 4000, env: { HOME: os.homedir() } }, (error, stdout) => {
      const match = String(stdout || '').match(/__PATH__(.*)__PATH__/);
      resolve(match ? match[1] : '');
    });
  });
}

class LocalRuntime {
  constructor({ entry, dataDir, log }) {
    this.entry = entry;
    this.dataDir = dataDir;
    this.log = log || (() => {});
    this.child = null;
    this.port = 0;
    this.token = '';
    this.state = { status: 'stopped', error: '' };
    this.apiKey = '';
    this.openaiKey = '';
    this.codexUsesKey = false;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(apiKey, openaiKey, codexUsesKey) {
    this.apiKey = apiKey || '';
    this.openaiKey = openaiKey || '';
    this.codexUsesKey = Boolean(codexUsesKey);
    const codex = codexEnv({ openaiKey: this.openaiKey, codexUsesKey: this.codexUsesKey, dataDir: this.dataDir });
    // Signed in again from the current key on every start, so a changed key
    // is never left behind in an old login.
    if (codex.CODEX_HOME) fs.rmSync(path.join(codex.CODEX_HOME, 'auth.json'), { force: true });
    if (!fs.existsSync(this.entry)) {
      this.state = { status: 'error', error: `Runtime not found at ${this.entry}` };
      return this.state;
    }
    this.state = { status: 'starting', error: '' };
    this.port = await freePort();
    this.token = crypto.randomBytes(32).toString('hex');
    const runtimeDir = path.join(this.dataDir, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const logFile = fs.openSync(path.join(this.dataDir, 'runtime.log'), 'a');

    const env = {
      // Electron's own binary runs the runtime as plain Node: no separate
      // Node install needed on the Mac.
      ELECTRON_RUN_AS_NODE: '1',
      HOME: os.homedir(),
      USER: os.userInfo().username,
      LANG: process.env.LANG || 'en_US.UTF-8',
      TMPDIR: os.tmpdir(),
      PATH: mergePath(await loginShellPath(), process.env.PATH, FALLBACK_PATH),
      NODE_ENV: 'production',
      PORT: String(this.port),
      ONECLAW_HOST: '127.0.0.1',
      ONECLAW_INTERNAL_TOKEN: this.token,
      // The gate is in the app: a task is only sent for a folder the person
      // opened with the folder picker (bridge.js → buildLocalTaskInput). The
      // runtime's list is the whole disk because folders may live outside the
      // home folder (external drives, /Volumes), and restarting the runtime on
      // every newly opened folder would drop running tasks.
      ONECLAW_CODE_WORKSPACE_ALLOWLIST: '/',
      ONECLAW_TASK_WORKSPACE_ROOT: path.join(this.dataDir, 'tasks'),
      ONECLAW_AGENT_STATE_DIR: path.join(this.dataDir, 'agent-sessions'),
      // Task history survives restarts. A task that was running when the app
      // quit is marked interrupted on the next start, not resumed: local tasks
      // may edit the person's own folder, and resuming that unasked is wrong.
      ONECLAW_TASK_STORE: 'file',
      ONECLAW_TASK_STORE_FILE: path.join(this.dataDir, 'tasks.json'),
      ONECLAW_RECOVER_ON_BOOT: 'false',
      ONECLAW_AGENT_MAX_CONCURRENCY: '2',
      // Same room as the cloud runtime (150 on Railway; the runtime's own
      // default is 50). A local run that needs to install and verify ran out
      // of turns at 50 after its code was already right.
      AGENT_ENGINE_MAX_TURNS: '150',
      ...(this.apiKey ? { ANTHROPIC_API_KEY: this.apiKey } : {}),
      // For TheOne's engine on OpenAI models. Not OPENAI_API_KEY: Codex would
      // take that over the ChatGPT login it runs on, and bill the key instead.
      ...(this.openaiKey ? { THEONE_OPENAI_API_KEY: this.openaiKey } : {}),
      // Only when Codex is set to use the key: see codexEnv.
      ...codex,
    };

    this.child = spawn(process.execPath, [this.entry], {
      cwd: runtimeDir,
      env,
      stdio: ['ignore', logFile, logFile],
    });
    const child = this.child;
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.state.status !== 'stopping') {
        this.state = { status: 'error', error: `Runtime exited (${signal || code}). See runtime.log.` };
        this.log(this.state.error);
      } else {
        this.state = { status: 'stopped', error: '' };
      }
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!this.child) break;
      const healthy = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) })
        .then((response) => response.ok).catch(() => false);
      if (healthy) {
        this.state = { status: 'ready', error: '' };
        return this.state;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (this.state.status === 'starting') this.state = { status: 'error', error: 'Runtime did not become healthy within 30s. See runtime.log.' };
    return this.state;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.state = { status: 'stopping', error: '' };
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.child = null;
    this.state = { status: 'stopped', error: '' };
  }

  async restart(apiKey, openaiKey, codexUsesKey) {
    await this.stop();
    return this.start(apiKey, openaiKey, codexUsesKey);
  }

  async request(method, pathname, body, headers = {}) {
    if (this.state.status !== 'ready') throw new Error(this.state.error || `Local runtime is ${this.state.status}`);
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = data && data.error ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : `HTTP ${response.status}`;
      throw new Error(detail.slice(0, 500));
    }
    return data;
  }
}

module.exports = { LocalRuntime, freePort, loginShellPath };
