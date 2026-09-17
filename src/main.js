'use strict';

/**
 * TheOne for macOS.
 *
 * One window with the TheOne OS surface, and a local OneClaw runtime so coding
 * tasks can run on folders on this Mac (the cloud runtime stays available from
 * the same UI). See runtime.js for how the runtime is contained, and bridge.js
 * for what the page is allowed to ask for.
 */

const { app, BrowserWindow, Menu, Notification, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { deepLinkPath, isAllowedOrigin, isSignInNavigation, startUrl, updateMenuItem } = require('./policy');
const { createUpdater } = require('./updater');
const { LocalRuntime } = require('./runtime');
const { Settings } = require('./settings');
const { registerBridge } = require('./bridge');

const START_URL = startUrl();
const START_ORIGIN = new URL(START_URL).origin;
process.env.THEONE_DESKTOP_ORIGIN = START_ORIGIN;

// Development and tests only (before the single-instance lock, which is keyed
// on the data folder, so a test instance runs beside an installed app): a separate data folder, and a key from the
// environment instead of the Keychain (which would prompt). Ignored when packaged.
if (!app.isPackaged && process.env.THEONE_DESKTOP_DATA_DIR) {
  app.setPath('userData', process.env.THEONE_DESKTOP_DATA_DIR);
}
const devApiKey = !app.isPackaged ? String(process.env.THEONE_DESKTOP_DEV_API_KEY || '') : '';

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAsDefaultProtocolClient('theone');


let mainWindow = null;
let settingsWindow = null;
let pendingDeepLink = null;
const dataDir = app.getPath('userData');
fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, 'app.log');
const log = (message) => {
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); } catch { /* ignore */ }
};

function runtimeEntry() {
  if (process.env.THEONE_ONECLAW_ENTRY) return process.env.THEONE_ONECLAW_ENTRY;
  if (app.isPackaged) return path.join(process.resourcesPath, 'oneclaw', 'dist', 'index.js');
  return path.resolve(__dirname, '..', '..', 'oneclaw-v5-phase4', 'dist', 'index.js');
}

let settings;
let runtime;
let updater;
let quitting = false;

function send(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:event', event);
}

function navigateTo(pathname) {
  if (!mainWindow) return;
  mainWindow.loadURL(new URL(pathname, START_ORIGIN).toString());
  mainWindow.show();
  mainWindow.focus();
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    title: 'TheOne 设置',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0b0e',
    parent: mainWindow || undefined,
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

async function pickFolderAndOpen() {
  if (!mainWindow) return;
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择要让 TheOne 工作的文件夹', properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return;
  settings.addWorkspace(result.filePaths[0]);
  send({ type: 'command', command: 'new-code-task', workspacePath: result.filePaths[0] });
}

function updateItem() {
  const item = updateMenuItem(updater ? updater.state() : { status: 'disabled' });
  return {
    label: item.label,
    enabled: item.enabled,
    click: () => {
      if (item.action === 'install') void installUpdate();
      else if (item.action === 'check') void updater.check({ userInitiated: true });
    },
  };
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

async function installUpdate() {
  // Stop the runtime first: quitting for an update skips the normal quit path.
  quitting = true;
  await runtime?.stop().catch(() => undefined);
  if (!updater.install()) quitting = false;
}

function buildMenu() {
  const template = [
    {
      label: 'TheOne',
      submenu: [
        { role: 'about', label: '关于 TheOne' },
        updateItem(),
        { type: 'separator' },
        { label: '设置…', accelerator: 'CommandOrControl+,', click: openSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 TheOne' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: '退出 TheOne' },
      ],
    },
    {
      label: '文件',
      submenu: [
        { label: '新建会话', accelerator: 'CommandOrControl+N', click: () => send({ type: 'command', command: 'new-session' }) },
        { label: '新建编码任务', accelerator: 'CommandOrControl+Shift+N', click: () => send({ type: 'command', command: 'new-code-task' }) },
        { label: '打开文件夹…', accelerator: 'CommandOrControl+O', click: pickFolderAndOpen },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '视图',
      submenu: [
        { label: '切换侧栏', accelerator: 'CommandOrControl+B', click: () => send({ type: 'command', command: 'toggle-rail' }) },
        { label: '切换详情面板', accelerator: 'CommandOrControl+I', click: () => send({ type: 'command', command: 'toggle-inspector' }) },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        { label: '打开运行日志', click: () => shell.showItemInFolder(path.join(dataDir, 'runtime.log')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function offlinePage(error) {
  const html = `<!doctype html><meta charset="utf-8"><title>TheOne</title>
  <body style="margin:0;display:grid;place-items:center;height:100vh;background:#0a0b0e;color:#ededf0;font:14px -apple-system,'PingFang SC',sans-serif;-webkit-app-region:drag">
  <div style="text-align:center;max-width:420px"><h2 style="margin:0 0 8px">无法连接 TheOne</h2>
  <p style="color:#a1a1aa;margin:0 0 18px">${String(error).replace(/[<>&]/g, '')}</p>
  <button onclick="location.href='${START_URL}'" style="-webkit-app-region:no-drag;font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#ededf0;color:#0a0b0e;cursor:pointer">重试</button></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow() {
  // First launch: a comfortable window sized to the screen (about three
  // quarters of it, at most 1280×820), centred. Afterwards the window keeps
  // whatever size the person gave it.
  const { screen } = require('electron');
  const area = screen.getPrimaryDisplay().workAreaSize;
  const bounds = settings.windowBounds || {
    width: Math.min(1280, Math.round(area.width * 0.75)),
    height: Math.min(820, Math.round(area.height * 0.8)),
    center: true,
  };
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 860,
    minHeight: 560,
    title: 'TheOne',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: '#0a0b0e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: [`--theone-origin=${START_ORIGIN}`],
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return;
    settings.windowBounds = mainWindow.getBounds();
  };
  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);

  // Only TheOne loads in this window. Everything else is the browser's job,
  // and never receives the desktop bridge.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedOrigin(url) || isSignInNavigation(url) || url.startsWith('data:')) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: navigation replaced
    log(`load failed ${code} ${description} ${url}`);
    mainWindow.loadURL(offlinePage(`${description}（${code}）`));
  });

  const initial = pendingDeepLink ? new URL(pendingDeepLink, START_ORIGIN).toString() : START_URL;
  pendingDeepLink = null;
  mainWindow.loadURL(initial);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('open-url', (event, link) => {
  event.preventDefault();
  const target = deepLinkPath(link);
  if (!target) return;
  if (mainWindow) navigateTo(target);
  else pendingDeepLink = target;
});

app.on('second-instance', (_event, argv) => {
  const link = argv.find((arg) => arg.startsWith('theone://'));
  if (link && deepLinkPath(link)) navigateTo(deepLinkPath(link));
  else if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

app.whenReady().then(async () => {
  settings = new Settings({ dataDir, safeStorage });
  runtime = new LocalRuntime({ entry: runtimeEntry(), dataDir, log });
  if (devApiKey) settings.devApiKey = devApiKey;
  registerBridge({ runtime, settings, getWindow: () => mainWindow, openSettings, log });
  let lastUpdateStatus = '';
  updater = createUpdater({
    app,
    log,
    notify,
    // Rebuild the menu when the item's text changes, not on every progress tick.
    onChange: (state) => {
      const key = `${state.status}:${state.version}:${Math.floor((state.progress || 0) / 10)}`;
      if (key !== lastUpdateStatus) { lastUpdateStatus = key; buildMenu(); }
    },
  });
  buildMenu();
  createWindow();

  // The window does not wait for the runtime: the cloud side of TheOne works
  // while it starts, and the page hears when it is ready.
  const state = await runtime.start(devApiKey || settings.getApiKey());
  log(`runtime ${state.status}${state.error ? `: ${state.error}` : ''}`);
  send({ type: 'runtime', runtime: state, hasApiKey: settings.hasApiKey });
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', async (event) => {
  if (quitting || !runtime) return;
  event.preventDefault();
  quitting = true;
  await runtime.stop().catch(() => undefined);
  app.quit();
});

app.on('window-all-closed', () => {
  // macOS convention: the app stays in the Dock; the runtime keeps any
  // running task alive until Quit.
});
