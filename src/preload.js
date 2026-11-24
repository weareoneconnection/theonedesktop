'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * window.theoneDesktop — present only when TheOne runs inside the desktop app.
 * The main process re-checks the origin on every call; this is the first gate.
 */
// The origin the app was started for arrives as an argument: a sandboxed
// preload does not see the main process's environment.
const originArg = (process.argv || []).find((arg) => arg.startsWith('--theone-origin='));
const allowed = [
  'https://www.the1os.io',
  // Kept for one migration release; the server permanently redirects it.
  'https://theone-eta.vercel.app',
  originArg ? originArg.slice('--theone-origin='.length) : '',
].filter(Boolean);

if (allowed.includes(window.location.origin)) {
  contextBridge.exposeInMainWorld('theoneDesktop', {
    isDesktop: true,
    /** darwin or win32: the web shell leaves room for the traffic lights only on a Mac. */
    platform: process.platform,
    info: () => ipcRenderer.invoke('desktop:info'),
    /** Account boundary for the device-wide runtime. No task call works before this. */
    setIdentity: (identity) => ipcRenderer.invoke('desktop:setIdentity', identity),
    /** This Mac's signed isolation statement for a TheOne challenge. */
    attest: (tenantId, challenge) => ipcRenderer.invoke('desktop:attest', { tenantId, challenge }),
    pickWorkspace: () => ipcRenderer.invoke('desktop:pickWorkspace'),
    forgetWorkspace: (folder) => ipcRenderer.invoke('desktop:forgetWorkspace', folder),
    /** Safe project metadata for the workspace picker; never returns file contents. */
    inspectWorkspace: (folder) => ipcRenderer.invoke('desktop:inspectWorkspace', folder),
    openSettings: (locale) => ipcRenderer.invoke('desktop:openSettings', locale),
    /** The settings centre in the page (0.4.0): read state; keys are write-only and confirmed natively. */
    settings: () => ipcRenderer.invoke('desktop:settings'),
    setApiKey: (value) => ipcRenderer.invoke('desktop:setApiKey', value),
    setOpenAIKey: (value) => ipcRenderer.invoke('desktop:setOpenAIKey', value),
    setCodexUsesApiKey: (value) => ipcRenderer.invoke('desktop:setCodexUsesApiKey', value),
    restartRuntime: () => ipcRenderer.invoke('desktop:restartRuntime'),
    /** The terminal: { enabled, folders, auditFile }. Turning it on (or on for a folder) asks the person in a native dialog. */
    terminalSettings: () => ipcRenderer.invoke('desktop:terminalSettings'),
    setTerminalEnabled: (value) => ipcRenderer.invoke('desktop:setTerminalEnabled', value),
    setTerminalFolder: (folder, on) => ipcRenderer.invoke('desktop:setTerminalFolder', folder, on),
    /** Stop the terminal commands running for a conversation. */
    terminalStop: (sessionId) => ipcRenderer.invoke('desktop:terminalStop', sessionId),
    /**
     * MCP servers (programs that give TheOne more tools). Adding one, turning it on and choosing
     * its tools are each confirmed in a native dialog; removing and turning off are not.
     */
    mcpServers: () => ipcRenderer.invoke('desktop:mcpServers'),
    mcpAddServer: (definition) => ipcRenderer.invoke('desktop:mcpAddServer', definition),
    mcpRemoveServer: (id) => ipcRenderer.invoke('desktop:mcpRemoveServer', id),
    mcpSetEnabled: (id, on) => ipcRenderer.invoke('desktop:mcpSetEnabled', id, on),
    mcpDiscover: (id) => ipcRenderer.invoke('desktop:mcpDiscover', id),
    mcpApproveTools: (id, names, digest) => ipcRenderer.invoke('desktop:mcpApproveTools', id, names, digest),
    mcpReset: (id) => ipcRenderer.invoke('desktop:mcpReset', id),
    /**
     * Computer use (TheOne looking at applications you chose). Turning it on and adding an application
     * are each confirmed in a native dialog; stopping, removing and clearing records are not.
     */
    computerState: () => ipcRenderer.invoke('desktop:computerState'),
    computerSetEnabled: (on) => ipcRenderer.invoke('desktop:computerSetEnabled', on),
    computerAddApp: (name) => ipcRenderer.invoke('desktop:computerAddApp', name),
    computerRemoveApp: (name) => ipcRenderer.invoke('desktop:computerRemoveApp', name),
    computerStop: () => ipcRenderer.invoke('desktop:computerStop'),
    computerClearRecords: () => ipcRenderer.invoke('desktop:computerClearRecords'),
    installCodex: () => ipcRenderer.invoke('desktop:installCodex'),
    settingsInApp: () => ipcRenderer.invoke('desktop:settingsInApp'),
    createTask: (input) => ipcRenderer.invoke('desktop:createTask', input),
    /** Which coding engines this Mac can run right now. */
    engines: () => ipcRenderer.invoke('desktop:engines'),
    /** Sign in to, or install, an engine that is not ready yet. */
    engineSetup: (engine) => ipcRenderer.invoke('desktop:engineSetup', engine),
    getTask: (taskId) => ipcRenderer.invoke('desktop:getTask', taskId),
    /** Account/thread-scoped durable history with signed result receipts. */
    listTasks: (query) => ipcRenderer.invoke('desktop:listTasks', query),
    /** New log lines for a running task, from a cursor. */
    taskLogs: (taskId, since) => ipcRenderer.invoke('desktop:taskLogs', taskId, since),
    pendingTasks: () => ipcRenderer.invoke('desktop:pendingTasks'),
    /** What the tasks on this Mac cost, for the account menu. */
    usage: () => ipcRenderer.invoke('desktop:usage'),
    /** A read the chat agent asked this Mac for; allowlisted and folder-gated. */
    runAction: (action, input) => ipcRenderer.invoke('desktop:runAction', { action, input }),
    taskAction: (taskId, action) => ipcRenderer.invoke('desktop:taskAction', taskId, action),
    steerTask: (taskId, message) => ipcRenderer.invoke('desktop:steerTask', taskId, message),
    reveal: (folder) => ipcRenderer.invoke('desktop:reveal', folder),
    notify: (title, body) => ipcRenderer.invoke('desktop:notify', title, body),
    setBadge: (count) => ipcRenderer.invoke('desktop:setBadge', count),
    /**
     * The preview view: a real browser view inside the window for the page the
     * project serves (or a file in an opened folder). Its state arrives through
     * onEvent as { type: 'preview', ... }.
     */
    preview: {
      open: (input, rect) => ipcRenderer.invoke('desktop:previewOpen', input, rect),
      setBounds: (rect) => ipcRenderer.invoke('desktop:previewBounds', rect),
      setVisible: (flag) => ipcRenderer.invoke('desktop:previewVisible', flag),
      reload: () => ipcRenderer.invoke('desktop:previewReload'),
      stop: () => ipcRenderer.invoke('desktop:previewStop'),
      back: () => ipcRenderer.invoke('desktop:previewBack'),
      forward: () => ipcRenderer.invoke('desktop:previewForward'),
      devtools: () => ipcRenderer.invoke('desktop:previewDevtools'),
      capture: () => ipcRenderer.invoke('desktop:previewCapture'),
      state: () => ipcRenderer.invoke('desktop:previewState'),
      close: () => ipcRenderer.invoke('desktop:previewClose'),
    },
    /**
     * The project's own dev server, started by a button the person pressed.
     * State arrives through onEvent as { type: 'devserver', ... }.
     */
    devServer: {
      start: (folder) => ipcRenderer.invoke('desktop:devServerStart', folder),
      stop: (folder) => ipcRenderer.invoke('desktop:devServerStop', folder),
      state: (folder) => ipcRenderer.invoke('desktop:devServerState', folder),
    },
    /** Menu commands and runtime changes pushed from the app. Returns an unsubscribe. */
    onEvent: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on('desktop:event', wrapped);
      return () => ipcRenderer.removeListener('desktop:event', wrapped);
    },
  });
}
