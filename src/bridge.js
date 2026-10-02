'use strict';

/**
 * What the TheOne page may ask of the desktop app.
 *
 * Every handler first checks the calling frame's origin. The runtime token
 * never leaves the main process; the page gets results, not credentials.
 */

const path = require('node:path');
const { access, readFile } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { dialog, ipcMain, Notification, shell, app } = require('electron');
const { buildLocalTaskInput, compactTask, engineName, fromLocalId, isAllowedOrigin, isOpenAIModel, localAgentCall, looksLikeAnthropicKey, looksLikeOpenAIKey, steeringMessage, toLocalId, usageRows } = require('./policy');
const { engineDocsUrl, listEngines, startCodexLogin } = require('./engines');
const { buildAttestation, loadOrCreateKey } = require('./attestation');
const { installCodex } = require('./codex-install');
const { createTaskOwnershipStore, identityKey } = require('./task-ownership');

const execFileAsync = promisify(execFile);
const SETTINGS_SHORTCUT = process.platform === 'darwin' ? '⌘,' : 'Ctrl+,';

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

/** Small, read-only project fingerprint shown before a workspace is bound. */
async function inspectWorkspace(folder) {
  const packagePath = path.join(folder, 'package.json');
  const [hasPackage, hasPyProject, hasCargo, hasGo, hasPnpm, hasYarn, hasBun] = await Promise.all([
    exists(packagePath), exists(path.join(folder, 'pyproject.toml')), exists(path.join(folder, 'Cargo.toml')),
    exists(path.join(folder, 'go.mod')), exists(path.join(folder, 'pnpm-lock.yaml')),
    exists(path.join(folder, 'yarn.lock')), exists(path.join(folder, 'bun.lockb')),
  ]);
  let language = hasPackage ? 'Node.js' : hasPyProject ? 'Python' : hasCargo ? 'Rust' : hasGo ? 'Go' : '';
  if (hasPackage) {
    try {
      const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
      if (pkg && (pkg.devDependencies?.typescript || pkg.dependencies?.typescript)) language = 'TypeScript';
    } catch { /* malformed package metadata is not a bridge failure */ }
  }
  let git = false;
  let branch = '';
  let dirtyFiles = 0;
  try {
    const root = await execFileAsync('git', ['-C', folder, 'rev-parse', '--show-toplevel'], { timeout: 3_000 });
    git = Boolean(String(root.stdout || '').trim());
    const [branchResult, statusResult] = await Promise.all([
      execFileAsync('git', ['-C', folder, 'branch', '--show-current'], { timeout: 3_000 }),
      execFileAsync('git', ['-C', folder, 'status', '--porcelain'], { timeout: 3_000 }),
    ]);
    branch = String(branchResult.stdout || '').trim();
    dirtyFiles = String(statusResult.stdout || '').split('\n').filter(Boolean).length;
  } catch { /* an ordinary folder is still a valid workspace */ }
  return {
    path: folder,
    name: path.basename(folder),
    git,
    branch,
    dirtyFiles,
    language,
    packageManager: hasPnpm ? 'pnpm' : hasYarn ? 'Yarn' : hasBun ? 'Bun' : hasPackage ? 'npm' : '',
  };
}

function registerBridge({ runtime, settings, getWindow, openSettings, onSettingsInApp, log }) {
  const guard = (handler) => async (event, ...args) => {
    const url = event.senderFrame ? event.senderFrame.url : '';
    if (!isAllowedOrigin(url)) {
      log(`refused bridge call from ${url || 'unknown frame'}`);
      throw new Error('This page is not allowed to use TheOne desktop features.');
    }
    return handler(...args);
  };

  const handle = (channel, handler) => ipcMain.handle(channel, guard(handler));
  const handleWithEvent = (channel, handler) => ipcMain.handle(channel, async (event, ...args) => {
    const url = event.senderFrame ? event.senderFrame.url : '';
    if (!isAllowedOrigin(url)) {
      log(`refused bridge call from ${url || 'unknown frame'}`);
      throw new Error('This page is not allowed to use TheOne desktop features.');
    }
    return handler(event, ...args);
  });

  const identities = new Map();
  const ownership = createTaskOwnershipStore(app.getPath('userData'));
  const currentIdentity = (event) => {
    const identity = identities.get(event.sender.id);
    if (!identity) throw new Error('Sign in again before using local tasks.');
    return identity;
  };

  handleWithEvent('desktop:setIdentity', async (event, identity) => {
    if (identity === null) { identities.delete(event.sender.id); return { ok: true, identityIsolation: true }; }
    // Validate before retaining it. The raw ids are never persisted here.
    identityKey(identity);
    const firstBinding = !identities.has(event.sender.id);
    identities.set(event.sender.id, { tenantId: String(identity.tenantId), userId: String(identity.userId) });
    if (firstBinding) event.sender.once('destroyed', () => identities.delete(event.sender.id));
    return { ok: true, identityIsolation: true };
  });

  let attestationKey = null;
  const deviceKey = () => (attestationKey ||= loadOrCreateKey(app.getPath('userData')));

  const info = () => ({
    version: app.getVersion(),
    platform: process.platform,
    runtime: runtime.state,
    hasApiKey: settings.hasApiKey,
    hasOpenAIKey: settings.hasOpenAIKey,
    codexUsesApiKey: settings.codexUsesApiKey,
    workspaces: settings.workspaces,
    identityIsolation: true,
  });

  handle('desktop:info', async () => {
    let attestation = null;
    try { attestation = { keyId: deviceKey().keyId, publicKey: deviceKey().publicKey }; } catch { /* key store unavailable */ }
    return { ...info(), attestation };
  });

  // TheOne's challenge in, this Mac's signed statement out. The statement
  // says only what the main process knows; the page cannot shape it.
  handle('desktop:attest', async (input) => buildAttestation(
    { tenantId: input && input.tenantId, challenge: input && input.challenge },
    { key: deviceKey(), version: app.getVersion(), platform: process.platform, arch: process.arch },
  ));

  handle('desktop:pickWorkspace', async () => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window, {
      title: '选择要让 TheOne 工作的文件夹',
      buttonLabel: '打开',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    settings.addWorkspace(result.filePaths[0]);
    return result.filePaths[0];
  });

  handle('desktop:forgetWorkspace', async (folder) => settings.removeWorkspace(String(folder || '')));

  handle('desktop:inspectWorkspace', async (folder) => {
    const target = path.resolve(String(folder || ''));
    const opened = settings.workspaces.some((item) => target === path.resolve(item));
    if (!opened) throw new Error('That folder was not opened in TheOne.');
    return inspectWorkspace(target);
  });

  handle('desktop:openSettings', async (locale) => { openSettings(locale); return true; });

  // Which engines this Mac can run, straight from the runtime that would run
  // them, so the page offers only choices that will work.
  handle('desktop:engines', async () => listEngines(runtime));

  // Fix an engine that is not ready: Codex signs in with its own login in
  // Terminal, the rest is a key in Settings or an install page.
  handle('desktop:engineSetup', async (engine) => {
    const name = engineName(engine);
    if (name === 'codex') return startCodexLogin({ dataDir: app.getPath('userData') });
    if (name === 'claude' && !settings.hasApiKey) { openSettings(); return { ok: true, opened: 'settings' }; }
    await shell.openExternal(engineDocsUrl(name));
    return { ok: true, opened: 'docs' };
  });

  handleWithEvent('desktop:createTask', async (event, body) => {
    const identity = currentIdentity(event);
    if (runtime.state.status !== 'ready') {
      throw new Error('本机 Code Runtime 未连接。请在 TheOne Desktop 设置中启动本机运行时后重试。');
    }
    // Codex brings its own account; TheOne on a GPT model needs the OpenAI
    // key; the rest call Anthropic and need that key.
    const onOpenAI = engineName(body && body.engine) === 'theone' && isOpenAIModel(body && body.model);
    if (onOpenAI && !settings.hasOpenAIKey) {
      throw new Error(`Add your OpenAI API key in TheOne → Settings (${SETTINGS_SHORTCUT}) to run OpenAI models on this computer.`);
    }
    if (!onOpenAI && !settings.hasApiKey && engineName(body && body.engine) !== 'codex') {
      throw new Error(`Add your Anthropic API key in TheOne → Settings (${SETTINGS_SHORTCUT}) to run tasks on this computer.`);
    }
    // A thread's next turn may continue in a copy the runtime kept.
    const input = buildLocalTaskInput(body, settings.workspaces, path.join(runtime.dataDir, 'tasks'));
    const created = await runtime.request('POST', '/v1/actions/execute', {
      action: input.analyze === true ? 'code.workspace.analyze' : 'code.patch.apply',
      approvalMode: input.analyze === true ? 'auto' : 'manual',
      input,
    }, { 'x-oneclaw-dispatch': 'background' });
    const id = created && (created.id || (created.task && created.task.id));
    if (!id) throw new Error('The local runtime did not return a task id.');
    ownership.claim(String(id), identity);
    return { taskId: toLocalId(id) };
  });

  const pendingFor = async (id) => {
    const list = await runtime.request('GET', '/v1/approvals/pending');
    return (Array.isArray(list) ? list : [])
      .filter((item) => !id || item.taskId === id)
      .map((item) => ({ id: String(item.id), taskId: toLocalId(String(item.taskId)), stepId: String(item.stepId || ''), action: String(item.action || ''), reason: String(item.reason || '').slice(0, 300), objective: String((item.input && item.input.objective) || '').slice(0, 200) }));
  };

  handleWithEvent('desktop:getTask', async (event, taskId) => {
    const id = fromLocalId(taskId);
    ownership.assertOwns(id, currentIdentity(event));
    const [raw, approvals] = await Promise.all([
      runtime.request('GET', `/v1/tasks/${encodeURIComponent(id)}`),
      pendingFor(id).catch(() => []),
    ]);
    const task = compactTask(raw);
    if (!task) throw new Error('task not found');
    return { task, approvals };
  });

  // A running task's log from a cursor, so a local task streams the same way
  // a cloud one does instead of re-fetching the whole task every two seconds.
  handleWithEvent('desktop:taskLogs', async (event, taskId, since) => {
    const id = fromLocalId(taskId);
    ownership.assertOwns(id, currentIdentity(event));
    const from = Number.isFinite(Number(since)) && Number(since) >= 0 ? Math.floor(Number(since)) : 0;
    const body = await runtime.request('GET', `/v1/tasks/${encodeURIComponent(id)}/logs?since=${from}`);
    return {
      logs: Array.isArray(body && body.logs) ? body.logs : [],
      cursor: Number(body && body.cursor) || from,
      status: String((body && body.status) || ''),
      done: Boolean(body && body.done),
    };
  });

  // What the tasks on this Mac cost: the runtime's recent tasks, reduced to
  // what the account menu needs. Logs and diffs stay here.
  handleWithEvent('desktop:usage', async (event) => {
    if (runtime.state.status !== 'ready') return { rows: [], available: false };
    const body = await runtime.request('GET', '/v1/tasks?limit=200');
    const identity = currentIdentity(event);
    const items = (Array.isArray(body && body.items) ? body.items : []).filter((item) => ownership.owns(item && item.id, identity));
    return { rows: usageRows(items), available: true };
  });

  // A read the chat agent asked this Mac for: the runtime answers it, the
  // allowlist and the folder gate decide whether it may.
  handle('desktop:runAction', async (body) => {
    if (runtime.state.status !== 'ready') throw new Error('The local runtime is not running.');
    const call = localAgentCall(body, settings.workspaces);
    const result = await runtime.request('POST', '/v1/actions/execute', {
      action: call.action,
      approvalMode: 'auto',
      input: call.input,
    });
    const step = (result && Array.isArray(result.steps) ? result.steps : []).find((item) => item && item.output);
    return { ok: true, action: call.action, output: (step && step.output) || result || null };
  });

  handleWithEvent('desktop:pendingTasks', async (event) => {
    if (runtime.state.status !== 'ready') return [];
    const list = await pendingFor(null);
    const identity = currentIdentity(event);
    return list.filter((item) => item.action === 'code.patch.apply' && ownership.owns(fromLocalId(item.taskId), identity)).map((item) => ({ taskId: item.taskId, objective: item.objective }));
  });

  handleWithEvent('desktop:taskAction', async (event, taskId, action) => {
    const id = fromLocalId(taskId);
    ownership.assertOwns(id, currentIdentity(event));
    if (action === 'approve_all') {
      const approvals = await pendingFor(id);
      for (const approval of approvals) {
        await runtime.request(
          'POST',
          `/v1/approvals/${encodeURIComponent(approval.id)}/approve`,
          { decidedBy: 'theone-desktop' },
          { 'x-oneclaw-dispatch': 'background' },
        );
      }
      return { ok: true, approved: approvals.length };
    }
    if (action === 'abort') {
      await runtime.request('POST', `/v1/tasks/${encodeURIComponent(id)}/agent/abort`, {});
      return { ok: true };
    }
    throw new Error('unsupported action');
  });

  // A note for a task that is still working: the agent reads it before its
  // next step (OneClaw's /agent/steer).
  handleWithEvent('desktop:steerTask', async (event, taskId, message) => {
    const id = fromLocalId(taskId);
    ownership.assertOwns(id, currentIdentity(event));
    await runtime.request('POST', `/v1/tasks/${encodeURIComponent(id)}/agent/steer`, { message: steeringMessage(message) });
    return { ok: true };
  });

  handle('desktop:reveal', async (folder) => {
    const target = String(folder || '');
    if (!settings.workspaces.some((item) => target === item || target.startsWith(`${item}/`))) throw new Error('Not an opened folder.');
    shell.showItemInFolder(target);
    return true;
  });

  handle('desktop:notify', async (title, body) => {
    if (!Notification.isSupported()) return false;
    const notice = new Notification({ title: String(title || 'TheOne').slice(0, 80), body: String(body || '').slice(0, 240) });
    notice.on('click', () => { const window = getWindow(); if (window) { window.show(); window.focus(); } });
    notice.show();
    return true;
  });

  handle('desktop:setBadge', async (count) => {
    const value = Number(count) || 0;
    if (app.dock) app.dock.setBadge(value > 0 ? String(value) : '');
    return true;
  });

  // What settings can change, shared by the two places that change it: the
  // TheOne page's settings centre (0.4.0) and the local settings window kept
  // for older pages. Keys are write-only — neither ever reads one back.
  const announce = (state) => {
    const window = getWindow();
    if (window) window.webContents.send('desktop:event', { type: 'runtime', runtime: state, hasApiKey: settings.hasApiKey });
    return state;
  };
  const restartRuntime = async () => announce(await runtime.restart(...settings.runtimeArgs()));
  const ops = {
    get: () => ({ hasApiKey: settings.hasApiKey, hasOpenAIKey: settings.hasOpenAIKey, codexUsesApiKey: settings.codexUsesApiKey, runtime: runtime.state, workspaces: settings.workspaces, version: app.getVersion(), platform: process.platform }),
    async setApiKey(value) {
      const key = String(value || '').trim();
      if (key && !looksLikeAnthropicKey(key)) throw new Error('That does not look like an Anthropic API key (sk-ant-…).');
      settings.setApiKey(key);
      return { hasApiKey: settings.hasApiKey, runtime: await restartRuntime() };
    },
    async setOpenAIKey(value) {
      const key = String(value || '').trim();
      if (key && !looksLikeOpenAIKey(key)) throw new Error('That does not look like an OpenAI API key (sk-…).');
      settings.setOpenAIKey(key);
      // Without a key there is nothing for Codex to use: back to its own login.
      if (!key) settings.codexUsesApiKey = false;
      return { hasOpenAIKey: settings.hasOpenAIKey, codexUsesApiKey: settings.codexUsesApiKey, runtime: await restartRuntime() };
    },
    async setCodexUsesApiKey(value) {
      if (value && !settings.hasOpenAIKey) throw new Error('Save an OpenAI API key first.');
      settings.codexUsesApiKey = Boolean(value);
      return { codexUsesApiKey: settings.codexUsesApiKey, runtime: await restartRuntime() };
    },
    // Bring the local runtime back without quitting the app. It can die for
    // reasons that have nothing to do with the app — a crash, the machine
    // sleeping, someone killing the process.
    async restartRuntime() {
      return { runtime: await restartRuntime(), hasApiKey: settings.hasApiKey };
    },
    async engineSetup(engine) {
      const name = engineName(engine);
      if (name === 'codex') return startCodexLogin({ dataDir: app.getPath('userData') });
      await shell.openExternal(engineDocsUrl(name));
      return { ok: true, opened: 'docs' };
    },
  };
  // Install the pinned Codex into the app's data folder, then restart the
  // runtime so it picks it up. One install at a time.
  let codexInstalling = null;
  const installPinnedCodex = async (onProgress) => {
    codexInstalling = codexInstalling || installCodex({ dataDir: app.getPath('userData'), onProgress }).finally(() => { codexInstalling = null; });
    const result = await codexInstalling;
    return { binary: result.binary, version: result.version, runtime: await restartRuntime() };
  };

  // The page asks to change a key: the person confirms it here, in a dialog
  // the page cannot draw or click. A page that went wrong — or someone else's
  // script on it — cannot quietly swap in a key of its own, which would send
  // this computer's coding work to their account.
  const confirmKeyChange = async (label, value) => {
    const clearing = !String(value || '').trim();
    const english = app.getLocale().toLowerCase().startsWith('en');
    const window = getWindow();
    const options = {
      type: 'question',
      buttons: english ? [clearing ? 'Remove' : 'Save', 'Cancel'] : [clearing ? '移除' : '保存', '取消'],
      defaultId: 0,
      cancelId: 1,
      message: english
        ? (clearing ? `Remove the ${label} key from this computer?` : `Save a new ${label} key on this computer?`)
        : (clearing ? `从这台电脑上移除 ${label} 密钥？` : `在这台电脑上保存新的 ${label} 密钥？`),
      detail: english
        ? 'Requested from TheOne settings. The key is encrypted in the system keychain and never sent to TheOne.'
        : '来自 TheOne 设置。密钥用系统钥匙串加密保存在本机，不会发送给 TheOne。',
    };
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (response !== 0) throw new Error(english ? 'Cancelled.' : '已取消。');
  };

  // The TheOne page's settings centre.
  handle('desktop:settings', async () => ops.get());
  handle('desktop:setApiKey', async (value) => { await confirmKeyChange('Anthropic', value); return ops.setApiKey(value); });
  handle('desktop:setOpenAIKey', async (value) => { await confirmKeyChange('OpenAI', value); return ops.setOpenAIKey(value); });
  handle('desktop:setCodexUsesApiKey', async (value) => ops.setCodexUsesApiKey(value));
  handle('desktop:restartRuntime', async () => ops.restartRuntime());
  handle('desktop:installCodex', async () => installPinnedCodex((progress) => {
    const window = getWindow();
    if (window) window.webContents.send('desktop:event', { type: 'codexInstall', progress });
  }));
  // The page says it has a settings centre: ⌘, opens it there from now on,
  // until the page navigates away (main.js resets it).
  handle('desktop:settingsInApp', async () => { if (onSettingsInApp) onSettingsInApp(); return true; });

  // The local settings window is a file, not the web page: its own channel,
  // checked against the file it was loaded from.
  const local = (handler) => async (event, ...args) => {
    if (!String(event.senderFrame && event.senderFrame.url).startsWith('file://')) throw new Error('refused');
    return handler(event, ...args);
  };
  ipcMain.handle('settings:get', local(() => ops.get()));
  ipcMain.handle('settings:setApiKey', local((_event, value) => ops.setApiKey(value)));
  ipcMain.handle('settings:setOpenAIKey', local((_event, value) => ops.setOpenAIKey(value)));
  ipcMain.handle('settings:setCodexUsesApiKey', local((_event, value) => ops.setCodexUsesApiKey(value)));
  ipcMain.handle('settings:restartRuntime', local(() => ops.restartRuntime()));
  ipcMain.handle('settings:engines', local(() => listEngines(runtime)));
  ipcMain.handle('settings:engineSetup', local((_event, engine) => ops.engineSetup(engine)));
  ipcMain.handle('settings:installCodex', local((event) => installPinnedCodex((progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('settings:codexInstallProgress', progress);
  })));
  ipcMain.handle('settings:forgetWorkspace', local((_event, folder) => settings.removeWorkspace(String(folder || ''))));

  return { info };
}

module.exports = { registerBridge };
