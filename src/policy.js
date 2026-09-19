'use strict';

/**
 * Pure rules for the desktop app, kept free of Electron so they can be tested
 * with node --test.
 */

const crypto = require('node:crypto');
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

/**
 * The window asking to start GitHub sign-in (TheOne's /api/auth/github).
 *
 * Sign-in does not happen in the window: Google and Apple refuse embedded
 * windows, and the person's browser already has their GitHub session,
 * passwords and passkeys. The app opens it in the browser instead and gets the
 * session handed back through theone://auth. Returns the page to come back
 * to, or null when the URL is not a sign-in start.
 */
function signInStart(url, env = process.env) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!isAllowedOrigin(url, env) || parsed.pathname !== '/api/auth/github') return null;
  const returnTo = parsed.searchParams.get('returnTo') || '/os';
  return returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/os';
}

/** The one-time code from theone://auth?code=…, or null. */
function authLinkCode(link) {
  let url;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'theone:' || url.hostname !== 'auth') return null;
  const code = url.searchParams.get('code') || '';
  return /^[A-Za-z0-9_-]{43}$/.test(code) ? code : null;
}

/** A PKCE-style pair: the verifier stays in the app, the challenge goes to the browser. */
function signInPair(randomBytes = crypto.randomBytes) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** The TheOne path for a theone:// link: theone://task/<id>, theone://code/new, theone://os. */
function deepLinkPath(link) {
  let url;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'theone:') return null;
  const parts = [url.hostname, ...url.pathname.split('/')].filter(Boolean);
  if (parts[0] === 'task' && /^[A-Za-z0-9:_-]{4,80}$/.test(parts[1] || '')) return `/os?task=${encodeURIComponent(parts[1])}`;
  if (parts[0] === 'code' && parts[1] === 'new') return '/os?code=new';
  // theone://auth is the sign-in hand-off, handled on its own.
  if (parts[0] === 'auth') return null;
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

const ENGINES = ['theone', 'claude', 'codex'];

/** The three engines, by the names the product and the runtime both use. */
function engineName(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'claude' || text === 'claude-agent') return 'claude';
  if (text === 'codex') return 'codex';
  return 'theone';
}

/** At most six files, 8MB each, 20MB together — the runtime's own limits. */
function localAttachments(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('Attachments must be a list.');
  if (raw.length > 6) throw new Error('一次最多带 6 个附件。');
  const files = [];
  let total = 0;
  for (const item of raw) {
    const record = item && typeof item === 'object' ? item : {};
    const name = String(record.name || '').trim();
    const content = String(record.content || '');
    if (!name || !content) throw new Error('附件缺少文件名或内容。');
    const payload = content.startsWith('data:') ? content.slice(content.indexOf(',') + 1) : content;
    const bytes = Math.floor((payload.length * 3) / 4);
    if (bytes > 8 * 1024 * 1024) throw new Error(`附件“${name}”太大了（超过 8MB）。`);
    total += bytes;
    if (total > 20 * 1024 * 1024) throw new Error('附件加起来太大了（超过 20MB）。');
    files.push({ name: name.slice(0, 120), content });
  }
  return files;
}

/**
 * Whether an objective is too short to act on. Chinese says in four characters
 * what English needs a sentence for, so "修复分页测试" is a whole instruction.
 */
function objectiveTooShort(text) {
  const value = String(text || '').trim();
  const cjk = (value.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk >= 4 ? false : value.length < 8;
}

/**
 * What to tell someone about an engine that cannot run yet, and the one thing
 * that would fix it. The runtime reports availability; this turns "not signed
 * in" into a button the app can actually offer.
 */
function engineAction(availability) {
  const engine = engineName(availability && availability.engine);
  const ready = Boolean(availability && availability.ready);
  if (ready) return { engine, action: 'none' };
  const detail = String((availability && availability.detail) || '');
  if (engine === 'codex') return { engine, action: detail.includes('未找到') ? 'install' : 'login' };
  if (engine === 'claude') return { engine, action: detail.includes('未安装') ? 'install' : 'key' };
  return { engine, action: 'key' };
}

/**
 * A local coding task, validated before it reaches the runtime.
 *
 * The workspace must be a folder the person picked in this app — not any path
 * the page names — so a page cannot point the agent at ~/.ssh.
 */
/** The models the task form offers. Keep in step with MODEL_OPTIONS in theone-complete. */
const CLAUDE_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1'];

function buildLocalTaskInput(body, pickedWorkspaces) {
  const value = body && typeof body === 'object' ? body : {};
  const objective = String(value.objective || '').trim();
  const workspacePath = String(value.workspacePath || '').trim();
  if (objectiveTooShort(objective)) throw new Error('Describe the change in at least a sentence.');
  if (objective.length > 8000) throw new Error('The objective is too long (8,000 characters maximum).');
  if (!workspacePath || !path.isAbsolute(workspacePath)) throw new Error('Choose a folder on this Mac.');
  const picked = (pickedWorkspaces || []).some((folder) => isInside(folder, workspacePath));
  if (!picked) throw new Error('That folder was not opened in TheOne. Use "Open folder…" first.');

  const input = { objective, workspacePath };
  // Files handed to the run — a screenshot, a log, a spec. The runtime writes
  // them into the workspace before the agent starts; the caps match its own.
  const attachments = localAttachments(value.attachments);
  if (attachments.length) input.attachments = attachments;
  // A big task does not fit in the runtime's default turn limit.
  if (value.maxTurns !== undefined && value.maxTurns !== '') {
    const turns = Number(value.maxTurns);
    if (!Number.isInteger(turns) || turns < 10 || turns > 200) throw new Error('Turn limit must be a whole number between 10 and 200.');
    input.maxTurns = turns;
  }
  // Which agent executes it. The runtime falls back to its own engine when the
  // chosen one is not installed or not signed in on this Mac.
  const engine = engineName(value.engine);
  if (engine !== 'theone') input.engine = engine;
  // Which Claude model it runs on. The runtime hands it to the Claude CLI as
  // --model, so only the models the form offers get through; Codex runs
  // OpenAI models and never takes one.
  const model = String(value.model || '').trim();
  if (model && engine !== 'codex') {
    if (!CLAUDE_MODELS.includes(model)) throw new Error(`Unknown model: ${model.slice(0, 40)}`);
    input.model = model;
  }
  // An analysis reads and reports; the runtime runs it once, in a copy.
  if (value.analyze === true) {
    input.analyze = true;
    return input;
  }
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
        // An analysis task's summary is its report.
        summary: String(output.summary || '').slice(0, 30000),
        mode: String(output.mode || ''),
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

/** Updates run in the packaged app only, unless THEONE_DESKTOP_DISABLE_UPDATES=1. */
function updatesEnabled({ isPackaged, env = process.env }) {
  if (!isPackaged) return false;
  return !['1', 'true', 'yes'].includes(String(env.THEONE_DESKTOP_DISABLE_UPDATES || '').trim().toLowerCase());
}

/** The menu item for the updater's state. */
function updateMenuItem(state) {
  switch (state && state.status) {
    case 'ready': return { label: `重启以更新到 ${state.version}`, action: 'install', enabled: true };
    case 'checking': return { label: '正在检查更新…', action: 'none', enabled: false };
    case 'downloading': return { label: `正在下载 ${state.version}（${state.progress || 0}%）`, action: 'none', enabled: false };
    case 'disabled': return { label: '检查更新…', action: 'none', enabled: false };
    default: return { label: '检查更新…', action: 'check', enabled: true };
  }
}

function looksLikeAnthropicKey(value) {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(String(value || '').trim());
}

/** A note for a running task: plain text, not empty, not a novel. */
function steeringMessage(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Write what the agent should take into account.');
  if (text.length > 2000) throw new Error('The note is too long (2,000 characters maximum).');
  return text;
}

module.exports = {
  PRODUCTION_URL,
  ENGINES,
  engineName,
  engineAction,
  localAttachments,
  objectiveTooShort,
  FALLBACK_PATH,
  startUrl,
  allowedOrigins,
  isAllowedOrigin,
  signInStart,
  authLinkCode,
  signInPair,
  deepLinkPath,
  toLocalId,
  fromLocalId,
  isInside,
  buildLocalTaskInput,
  steeringMessage,
  compactTask,
  mergePath,
  looksLikeAnthropicKey,
  updatesEnabled,
  updateMenuItem,
};
