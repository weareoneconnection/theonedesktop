'use strict';

/**
 * Start the project's own dev server, from a button the person pressed.
 *
 * Only the `dev`-style script the project itself declares in package.json runs,
 * only inside a folder the person opened, and the address it prints is handed
 * to the preview (which still only loads loopback pages). Nothing here is
 * reachable by the agent: the call comes from the TheOne page's own button.
 * One server per folder; stopping kills its whole process group.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** Scripts a person would call "run it": first one the project defines wins. */
const SCRIPT_ORDER = ['dev', 'develop', 'start', 'serve', 'preview'];
const LOG_LINES = 120;
const READY_TIMEOUT_MS = 90_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{2,5})?[^\s"'<>)\]]*/i;

function realpathOrNull(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The folder, resolved, if it is one of the opened workspaces (or inside one); otherwise null. */
function allowedFolder(folder, workspaces) {
  const real = realpathOrNull(String(folder || ''));
  if (!real) return null;
  const roots = (Array.isArray(workspaces) ? workspaces : []).map((item) => realpathOrNull(String(item || ''))).filter(Boolean);
  return roots.some((root) => isInside(root, real)) ? real : null;
}

function packageManagerFor(folder) {
  const has = (name) => fs.existsSync(path.join(folder, name));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

/** { ok: true, script, manager, command } or { ok: false, reason }. */
function planDevServer(folder) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')); } catch { return { ok: false, reason: 'no_package_json' }; }
  const scripts = manifest && typeof manifest.scripts === 'object' && manifest.scripts ? manifest.scripts : {};
  const script = SCRIPT_ORDER.find((name) => typeof scripts[name] === 'string' && scripts[name].trim());
  if (!script) return { ok: false, reason: 'no_dev_script' };
  const manager = packageManagerFor(folder);
  return { ok: true, script, manager, command: `${manager} run ${script}` };
}

/** The local address a dev server printed, with colour codes removed; 0.0.0.0 becomes localhost. */
function addressFromOutput(text) {
  const match = String(text || '').replace(ANSI, '').match(URL_PATTERN);
  if (!match) return null;
  try {
    const url = new URL(match[0].replace(/[.,;:]+$/, ''));
    if (url.hostname === '0.0.0.0') url.hostname = 'localhost';
    return url.toString();
  } catch { return null; }
}

function createDevServers({ getWorkspaces, send, log = () => {}, spawnFn = spawn, platform = process.platform }) {
  const running = new Map();

  const snapshot = (entry) => ({ folder: entry.folder, command: entry.command, state: entry.state, url: entry.url, error: entry.error, log: entry.lines.slice(-40) });
  const emit = (entry) => send({ type: 'devserver', ...snapshot(entry) });

  function killTree(entry) {
    const child = entry.child;
    if (!child || child.exitCode !== null || !child.pid) return;
    try {
      if (platform === 'win32') spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGTERM');
    } catch { /* already gone */ }
    if (platform !== 'win32') {
      entry.killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000);
      if (entry.killTimer.unref) entry.killTimer.unref();
    }
  }

  function start(folder) {
    const real = allowedFolder(folder, getWorkspaces());
    if (!real) return { ok: false, reason: 'folder_not_opened' };
    const existing = running.get(real);
    if (existing && existing.state !== 'stopped' && existing.state !== 'failed') return { ok: true, ...snapshot(existing) };
    const plan = planDevServer(real);
    if (!plan.ok) return plan;

    const entry = { folder: real, command: plan.command, state: 'starting', url: '', error: '', lines: [], child: null, killTimer: null, readyTimer: null };
    running.set(real, entry);
    const env = { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', CI: '' };
    // An app opened from Finder has a thin PATH: a login shell brings the person's own (nvm, Homebrew).
    const child = platform === 'win32'
      ? spawnFn(plan.command, { cwd: real, env, shell: true, windowsHide: true })
      : spawnFn(process.env.SHELL || '/bin/zsh', ['-lc', plan.command], { cwd: real, env, detached: true });
    entry.child = child;

    const onData = (chunk) => {
      const text = String(chunk);
      for (const line of text.replace(ANSI, '').split(/\r?\n/)) if (line.trim()) entry.lines.push(line.slice(0, 300));
      if (entry.lines.length > LOG_LINES) entry.lines.splice(0, entry.lines.length - LOG_LINES);
      if (entry.state === 'starting') {
        const url = addressFromOutput(text);
        if (url) { entry.state = 'ready'; entry.url = url; clearTimeout(entry.readyTimer); }
      }
      emit(entry);
    };
    child.stdout && child.stdout.on('data', onData);
    child.stderr && child.stderr.on('data', onData);
    child.on('error', (error) => { entry.state = 'failed'; entry.error = String(error && error.message || error); emit(entry); });
    child.on('exit', (code, signal) => {
      clearTimeout(entry.readyTimer);
      clearTimeout(entry.killTimer);
      if (entry.state !== 'stopped') {
        entry.state = entry.state === 'ready' && (signal === 'SIGTERM' || code === 0) ? 'stopped' : 'failed';
        if (entry.state === 'failed') entry.error = signal ? `stopped by ${signal}` : `exited with code ${code}`;
      }
      log(`dev server ${plan.command} in ${real} ended (${code ?? signal})`);
      emit(entry);
    });
    entry.readyTimer = setTimeout(() => {
      if (entry.state !== 'starting') return;
      entry.error = 'no address printed yet';
      emit(entry);
    }, READY_TIMEOUT_MS);
    if (entry.readyTimer.unref) entry.readyTimer.unref();
    emit(entry);
    return { ok: true, ...snapshot(entry) };
  }

  function stop(folder) {
    const real = allowedFolder(folder, getWorkspaces());
    const entry = real && running.get(real);
    if (!entry) return { ok: true, state: 'stopped' };
    entry.state = 'stopped';
    killTree(entry);
    emit(entry);
    return { ok: true, ...snapshot(entry) };
  }

  function state(folder) {
    const real = allowedFolder(folder, getWorkspaces());
    const entry = real && running.get(real);
    return entry ? { ok: true, ...snapshot(entry) } : { ok: true, state: 'idle', plan: real ? planDevServer(real) : { ok: false, reason: 'folder_not_opened' } };
  }

  function stopAll() {
    for (const entry of running.values()) { entry.state = 'stopped'; killTree(entry); }
  }

  return { start, stop, state, stopAll };
}

module.exports = { addressFromOutput, allowedFolder, createDevServers, planDevServer, SCRIPT_ORDER };
