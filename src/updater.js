'use strict';

/**
 * Updates from GitHub Releases (electron-updater, Squirrel.Mac underneath).
 *
 * macOS installs an update only into a signed app, so an unsigned build
 * checks, fails validation and logs it — nothing is shown to the person. The
 * update downloads in the background and installs on the next quit, or right
 * away from the menu.
 */

const { updatesEnabled } = require('./policy');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 20 * 1000;

function createUpdater({ app, log, onChange, notify }) {
  const state = { status: 'disabled', version: '', progress: 0, error: '' };
  const set = (patch) => { Object.assign(state, patch); onChange({ ...state }); };

  if (!updatesEnabled({ isPackaged: app.isPackaged, env: process.env })) {
    return { state: () => ({ ...state }), check: async () => ({ ...state }), install: () => false };
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = { info: (m) => log(`update: ${m}`), warn: (m) => log(`update warn: ${m}`), error: (m) => log(`update error: ${m}`), debug: () => undefined };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  set({ status: 'idle' });

  let manual = false;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
  autoUpdater.on('update-not-available', () => {
    set({ status: 'current' });
    if (manual) notify('TheOne 已是最新版本', `当前版本 ${app.getVersion()}。`);
    manual = false;
  });
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: String(info.version || ''), progress: 0 }));
  autoUpdater.on('download-progress', (progress) => set({ progress: Math.round(Number(progress.percent) || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: String(info.version || state.version), progress: 100 });
    notify(`TheOne ${state.version} 已下载`, '退出时自动安装，或在菜单里选择"重启以更新"。');
    manual = false;
  });
  autoUpdater.on('error', (error) => {
    set({ status: 'error', error: String((error && error.message) || error).slice(0, 300) });
    if (manual) notify('检查更新失败', state.error);
    manual = false;
  });

  const check = async ({ userInitiated = false } = {}) => {
    if (state.status === 'checking' || state.status === 'downloading') return { ...state };
    if (state.status === 'ready') { if (userInitiated) notify(`TheOne ${state.version} 已下载`, '在菜单里选择"重启以更新"。'); return { ...state }; }
    manual = userInitiated;
    try { await autoUpdater.checkForUpdates(); } catch (error) { log(`update check failed: ${error.message}`); }
    return { ...state };
  };

  setTimeout(() => void check(), FIRST_CHECK_MS).unref?.();
  setInterval(() => void check(), CHECK_EVERY_MS).unref?.();

  return {
    state: () => ({ ...state }),
    check,
    install: () => {
      if (state.status !== 'ready') return false;
      autoUpdater.quitAndInstall(false, true);
      return true;
    },
  };
}

module.exports = { createUpdater };
