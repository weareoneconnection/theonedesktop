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
    info: () => ipcRenderer.invoke('desktop:info'),
    pickWorkspace: () => ipcRenderer.invoke('desktop:pickWorkspace'),
    forgetWorkspace: (folder) => ipcRenderer.invoke('desktop:forgetWorkspace', folder),
    /** Safe project metadata for the workspace picker; never returns file contents. */
    inspectWorkspace: (folder) => ipcRenderer.invoke('desktop:inspectWorkspace', folder),
    openSettings: () => ipcRenderer.invoke('desktop:openSettings'),
    createTask: (input) => ipcRenderer.invoke('desktop:createTask', input),
    /** Which coding engines this Mac can run right now. */
    engines: () => ipcRenderer.invoke('desktop:engines'),
    /** Sign in to, or install, an engine that is not ready yet. */
    engineSetup: (engine) => ipcRenderer.invoke('desktop:engineSetup', engine),
    getTask: (taskId) => ipcRenderer.invoke('desktop:getTask', taskId),
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
    /** Menu commands and runtime changes pushed from the app. Returns an unsubscribe. */
    onEvent: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on('desktop:event', wrapped);
      return () => ipcRenderer.removeListener('desktop:event', wrapped);
    },
  });
}
