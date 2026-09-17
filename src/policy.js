'use strict';

/**
 * Pure rules for the desktop app, kept free of Electron so they can be tested
 * with node --test.
 */

const path = require('node:path');

const PRODUCTION_URL = 'https://theone-eta.vercel.app/os';

/** The page the window loads. THEONE_DESKTOP_URL overrides it for development. */
function startUrl(env = process.env) {
  return String(env.THEONE_DESKTOP_URL || PRODUCTION_URL).trim();
}

/**
 * Origins allowed to use the local runtime.
 *
 * The window loads TheOne from the web, and the bridge it gets can start agent
 * runs that edit files on this Mac. So the bridge answers only the origin the
 * app itself was pointed at; anything the page navigates to elsewhere opens in
 * the browser instead, and gets nothing.
 */
function allowedOrigins(env = process.env) {
  const origins = new Set([new URL(PRODUCTION_URL).origin]);
  try { origins.add(new URL(startUrl(env)).origin); } catch { /* invalid override: production only */ }
  return origins;
}

function isAllowedOrigin(url, env = process.env) {
  try {
    return allowedOrigins(env).has(new URL(url).origin);
  } catch {
    return false;
  }
}

/** The TheOne path for a theone:// link: theone://task/<id>, theone://code/new, theone://os. */
function deepLinkPath(link) {
  let url;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'theone:') return null;
  const parts = [url.hostname, ...url.pathname.split('/')].filter(Boolean);
  if (parts[0] === 'task' && /^[A-Za-z0-9:_-]{4,80}$/.test(parts[1] || '')) return `/os?task=${encodeURIComponent(parts[1])}`;
  if (parts[0] === 'code' && parts[1] === 'new') return '/os?code=new';
  return '/os';
}

const TASK_ID = /^[A-Za-z0-9_-]{4,64}$/;
const LOCAL_PREFIX = 'local:';

function toLocalId(id) {
  return `${LOCAL_PREFIX}${id}`;
}

function fromLocalId(value) {
  const text = String(value || '');
  const id = text.startsWith(LOCAL_PREFIX) ? text.slice(LOCAL_PREFIX.length) : text;
  if (!TASK_ID.test(id)) throw new Error('invalid task id');
  return id;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * A local coding task, validated before it reaches the runtime.
 *
 * The workspace must be a folder the person picked in this app — not any path
 * the page names — so a page cannot point the agent at ~/.ssh.
 */
function buildLocalTaskInput(body, pickedWorkspaces) {
  const value = body && typeof body === 'object' ? body : {};
  const objective = String(value.objective || '').trim();
  const workspacePath = String(value.workspacePath || '').trim();
  if (objective.length < 8) throw new Error('Describe the change in at least a sentence.');
  if (objective.length > 8000) throw new Error('The objective is too long (8,000 characters maximum).');
  if (!workspacePath || !path.isAbsolute(workspacePath)) throw new Error('Choose a folder on this Mac.');
  const picked = (pickedWorkspaces || []).some((folder) => isInside(folder, workspacePath));
  if (!picked) throw new Error('That folder was not opened in TheOne. Use "Open folder…" first.');

  const input = { objective, workspacePath };
  if (value.isolate === true) input.isolate = true;
  const attempts = value.attempts === undefined ? 1 : Number(value.attempts);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('Attempts must be 1, 2 or 3.');
  if (attempts > 1) {
    if (value.isolate !== true) throw new Error('Several attempts need "Work on a copy".');
    input.attempts = attempts;
  }
  const verify = String(value.verify || '').trim();
  if (verify.length > 500) throw new Error('The verify command is too long.');
  if (verify) input.verify = verify;
  const setup = String(value.setup || '').trim();
  if (setup.length > 2000) throw new Error('The setup script is too long.');
  if (setup) input.setup = setup;
  return input;
}

/** The same compact task shape TheOne's /api/theone/agent/task returns. */
function compactTask(raw) {
  const task = raw && typeof raw === 'object' && 'task' in raw ? raw.task : raw;
  if (!task || typeof task !== 'object') return null;
  const logs = Array.isArray(task.logs) ? task.logs.slice(-200).map(String) : [];
  const steps = Array.isArray(task.steps) ? task.steps.map((step) => {
    const output = (step && step.output) || {};
    return {
      stepId: String(step.stepId || ''),
      action: String(step.action || ''),
      status: String(step.status || ''),
      output: {
        status: String(output.status || ''),
        verified: output.verified === true,
        verifyPassed: typeof output.verifyPassed === 'boolean' ? output.verifyPassed : null,
        summary: String(output.summary || '').slice(0, 8000),
        diff: String(output.diff || '').slice(0, 200000),
        diffStat: String(output.diffStat || '').slice(0, 4000),
        rollbackToken: String(output.rollbackToken || ''),
        workspaceMode: String(output.workspaceMode || ''),
        workspacePath: String(output.workspacePath || ''),
        keptAttempt: typeof output.keptAttempt === 'number' ? output.keptAttempt : null,
        attempts: Array.isArray(output.attempts) ? output.attempts : null,
        setupOutput: String(output.setupOutput || '').slice(0, 4000),
        error: String(step.error || output.error || '').slice(0, 2000),
      },
    };
  }) : [];
  const planned = task.metadata && task.metadata.normalizedTask && Array.isArray(task.metadata.normalizedTask.steps) ? task.metadata.normalizedTask.steps : [];
  const agentInput = (planned.find((step) => step && step.action === 'code.patch.apply') || {}).input || {};
  return {
    id: toLocalId(String(task.id || '')),
    status: String(task.status || ''),
    taskName: String(task.taskName || ''),
    objective: String(agentInput.objective || '').slice(0, 2000),
    target: String(agentInput.workspacePath || agentInput.repo || ''),
    createdAt: String(task.createdAt || ''),
    logs,
    steps,
  };
}

/**
 * PATH for the runtime.
 *
 * An app started from Finder inherits launchd's PATH (/usr/bin:/bin:…), so git
 * from Homebrew, node, pnpm and friends are missing and every agent command
 * that needs them fails. The login shell's PATH is merged in, then the usual
 * install locations as a fallback.
 */
function mergePath(...sources) {
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    for (const entry of String(source || '').split(':')) {
      const item = entry.trim();
      if (item && !seen.has(item)) { seen.add(item); out.push(item); }
    }
  }
  return out.join(':');
}

const FALLBACK_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function looksLikeAnthropicKey(value) {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(String(value || '').trim());
}

module.exports = {
  PRODUCTION_URL,
  FALLBACK_PATH,
  startUrl,
  allowedOrigins,
  isAllowedOrigin,
  deepLinkPath,
  toLocalId,
  fromLocalId,
  isInside,
  buildLocalTaskInput,
  compactTask,
  mergePath,
  looksLikeAnthropicKey,
};
