'use strict';

/**
 * What the TheOne page may ask of the desktop app.
 *
 * Every handler first checks the calling frame's origin. The runtime token
 * never leaves the main process; the page gets results, not credentials.
 */

const path = require('node:path');
const { dialog, ipcMain, Notification, shell, app } = require('electron');
const { buildLocalTaskInput, compactTask, engineName, fromLocalId, isAllowedOrigin, isOpenAIModel, looksLikeAnthropicKey, looksLikeOpenAIKey, steeringMessage, toLocalId } = require('./policy');
const { engineDocsUrl, listEngines, startCodexLogin } = require('./engines');

function registerBridge({ runtime, settings, getWindow, openSettings, log }) {
  const guard = (handler) => async (event, ...args) => {
    const url = event.senderFrame ? event.senderFrame.url : '';
    if (!isAllowedOrigin(url)) {
      log(`refused bridge call from ${url || 'unknown frame'}`);
      throw new Error('This page is not allowed to use TheOne desktop features.');
    }
    return handler(...args);
  };

  const handle = (channel, handler) => ipcMain.handle(channel, guard(handler));

  const info = () => ({
    version: app.getVersion(),
    platform: process.platform,
    runtime: runtime.state,
    hasApiKey: settings.hasApiKey,
    workspaces: settings.workspaces,
  });

  handle('desktop:info', async () => info());

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

  handle('desktop:openSettings', async () => { openSettings(); return true; });

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

  handle('desktop:createTask', async (body) => {
    // Codex brings its own account; TheOne on a GPT model needs the OpenAI
    // key; the rest call Anthropic and need that key.
    const onOpenAI = engineName(body && body.engine) === 'theone' && isOpenAIModel(body && body.model);
    if (onOpenAI && !settings.hasOpenAIKey) {
      throw new Error('Add your OpenAI API key in TheOne → Settings (⌘,) to run OpenAI models on this Mac.');
    }
    if (!onOpenAI && !settings.hasApiKey && engineName(body && body.engine) !== 'codex') {
      throw new Error('Add your Anthropic API key in TheOne → Settings (⌘,) to run tasks on this Mac.');
    }
    // A thread's next turn may continue in a copy the runtime kept.
    const input = buildLocalTaskInput(body, settings.workspaces, path.join(runtime.dataDir, 'tasks'));
    const created = await runtime.request('POST', '/v1/actions/execute', {
      action: 'code.patch.apply',
      approvalMode: 'manual',
      input,
    }, { 'x-oneclaw-dispatch': 'background' });
    const id = created && (created.id || (created.task && created.task.id));
    if (!id) throw new Error('The local runtime did not return a task id.');
    return { taskId: toLocalId(id) };
  });

  const pendingFor = async (id) => {
    const list = await runtime.request('GET', '/v1/approvals/pending');
    return (Array.isArray(list) ? list : [])
      .filter((item) => !id || item.taskId === id)
      .map((item) => ({ id: String(item.id), taskId: toLocalId(String(item.taskId)), stepId: String(item.stepId || ''), action: String(item.action || ''), reason: String(item.reason || '').slice(0, 300), objective: String((item.input && item.input.objective) || '').slice(0, 200) }));
  };

  handle('desktop:getTask', async (taskId) => {
    const id = fromLocalId(taskId);
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
  handle('desktop:taskLogs', async (taskId, since) => {
    const id = fromLocalId(taskId);
    const from = Number.isFinite(Number(since)) && Number(since) >= 0 ? Math.floor(Number(since)) : 0;
    const body = await runtime.request('GET', `/v1/tasks/${encodeURIComponent(id)}/logs?since=${from}`);
    return {
      logs: Array.isArray(body && body.logs) ? body.logs : [],
      cursor: Number(body && body.cursor) || from,
      status: String((body && body.status) || ''),
      done: Boolean(body && body.done),
    };
  });

  handle('desktop:pendingTasks', async () => {
    if (runtime.state.status !== 'ready') return [];
    const list = await pendingFor(null);
    return list.filter((item) => item.action === 'code.patch.apply').map((item) => ({ taskId: item.taskId, objective: item.objective }));
  });

  handle('desktop:taskAction', async (taskId, action) => {
    const id = fromLocalId(taskId);
    if (action === 'approve_all') {
      const approvals = await pendingFor(id);
      for (const approval of approvals) {
        await runtime.request('POST', `/v1/approvals/${encodeURIComponent(approval.id)}/approve`, { decidedBy: 'theone-desktop' });
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
  handle('desktop:steerTask', async (taskId, message) => {
    const id = fromLocalId(taskId);
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

  // The settings window is a local file, not the web page: its own channel,
  // checked against the file it was loaded from.
  ipcMain.handle('settings:get', (event) => {
    if (!String(event.senderFrame && event.senderFrame.url).startsWith('file://')) throw new Error('refused');
    return { hasApiKey: settings.hasApiKey, hasOpenAIKey: settings.hasOpenAIKey, codexUsesApiKey: settings.codexUsesApiKey, runtime: runtime.state, workspaces: settings.workspaces, version: app.getVersion() };
  });
  ipcMain.handle('settings:setApiKey', async (event, value) => {
    if (!String(event.senderFrame && event.senderFrame.url).startsWith('file://')) throw new Error('refused');
    const key = String(value || '').trim();
    if (key && !looksLikeAnthropicKey(key)) throw new Error('That does not look like an Anthropic API key (sk-ant-…).');
    settings.setApiKey(key);
    const state = await runtime.restart(...settings.runtimeArgs());
    const window = getWindow();
    if (window) window.webContents.send('desktop:event', { type: 'runtime', runtime: state, hasApiKey: settings.hasApiKey });
    return { hasApiKey: settings.hasApiKey, runtime: state };
  });
  ipcMain.handle('settings:setOpenAIKey', async (event, value) => {
    if (!String(event.senderFrame && event.senderFrame.url).startsWith('file://')) throw new Error('refused');
    const key = String(value || '').trim();
    if (key && !looksLikeOpenAIKey(key)) throw new Error('That does not look like an OpenAI API key (sk-…).');
    settings.setOpenAIKey(key);
    // Without a key there is nothing for Codex to use: back to its own login.
    if (!key) settings.codexUsesApiKey = false;
    const state = await runtime.restart(...settings.runtimeArgs());
    const window = getWindow();
    if (window) window.webContents.send('desktop:event', { type: 'runtime', runtime: state, hasApiKey: settings.hasApiKey });
    return { hasOpenAIKey: settings.hasOpenAIKey, codexUsesApiKey: settings.codexUsesApiKey, runtime: state };
  });
  ipcMain.handle('settings:setCodexUsesApiKey', async (event, value) => {
    if (!String(event.senderFrame && event.senderFrame.url).startsWith('file://')) throw new Error('refused');
    if (value && !settings.hasOpenAIKey) throw new Error('Save an OpenAI API key first.');
    settings.codexUsesApiKey = Boolean(value);
    const state = await runtime.restart(...settings.runtimeArgs());
    const window = getWindow();
    if (window) window.webContents.send('desktop:event', { type: 'runtime', runtime: state, hasApiKey: settings.hasApiKey });
    return { codexUsesApiKey: settings.codexUsesApiKey, runtime: state };
  });
  // Bring the local runtime back without quitting the app. It can die for
  // reasons that have nothing to do with the app — a crash, the machine
  // sleeping, someone killing the process — and until now the only way back
  // was to quit and reopen.
  ipcMain.handle('settings:restartRuntime', async (event) => {
    if (!String(event.senderFrame && event.senderFrame.url).startsWith('file://')) throw new Error('refused');
    // The same key the app started the runtime with, decrypted from the keychain.
    const state = await runtime.restart(...settings.runtimeArgs());
    const window = getWindow();
    if (window) window.webContents.send('desktop:event', { type: 'runtime', runtime: state, hasApiKey: settings.hasApiKey });
    return { runtime: state, hasApiKey: settings.hasApiKey };
  });

  ipcMain.handle('settings:engines', async (event) => {
    if (!String(event.senderFrame && event.senderFrame.url).startsWith('file://')) throw new Error('refused');
    return listEngines(runtime);
  });
  ipcMain.handle('settings:engineSetup', async (event, engine) => {
    if (!String(event.senderFrame && event.senderFrame.url).startsWith('file://')) throw new Error('refused');
    const name = engineName(engine);
    if (name === 'codex') return startCodexLogin({ dataDir: app.getPath('userData') });
    await shell.openExternal(engineDocsUrl(name));
    return { ok: true, opened: 'docs' };
  });
  ipcMain.handle('settings:forgetWorkspace', async (event, folder) => {
    if (!String(event.senderFrame && event.senderFrame.url).startsWith('file://')) throw new Error('refused');
    return settings.removeWorkspace(String(folder || ''));
  });

  return { info };
}

module.exports = { registerBridge };
