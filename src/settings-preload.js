'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  setApiKey: (value) => ipcRenderer.invoke('settings:setApiKey', value),
  forgetWorkspace: (folder) => ipcRenderer.invoke('settings:forgetWorkspace', folder),
  engines: () => ipcRenderer.invoke('settings:engines'),
  engineSetup: (engine) => ipcRenderer.invoke('settings:engineSetup', engine),
});
