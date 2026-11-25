'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProviderError, pngSize, createProvider, unsupportedProvider } = require('../src/computer/provider');
const { createMacProvider } = require('../src/computer/mac-provider');
const { createWinProvider } = require('../src/computer/win-provider');
const { createComputerActions } = require('../src/computer/actions');
const { ComputerSessions } = require('../src/computer/session');
const { RecordStore } = require('../src/computer/records');
const { bridgeContract, SUPPORTED_CAPABILITIES } = require('../src/bridge-contract');

/** A PNG with a real header of the given size (the rest is not a valid image, which nothing here decodes). */
function png(width = 600, height = 400, extra = 0) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8); header.write('IHDR', 12, 'latin1'); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(extra)]);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
const win = (over) => ({ owner: 'Notes', pid: 500, id: 10, title: 'Shopping', layer: 0, alpha: 1, w: 800, h: 600, ...over });

test('a PNG is read by its header, and nothing else counts as one', () => {
  assert.deepEqual(pngSize(png(120, 80)), { width: 120, height: 80 });
  for (const bad of [null, 'x', Buffer.alloc(10), Buffer.alloc(40), png(0, 10), png(30000, 10), Buffer.from('<html>not a picture, even if it is long enough to look like one</html>')]) assert.equal(pngSize(bad), null);
});

test('the provider is chosen by system, and is none where there is no way to take one window', () => {
  assert.equal(createProvider('linux'), unsupportedProvider);
  assert.equal(createProvider('darwin').supported, true);
  assert.equal(createProvider('win32', { desktopCapturer: {} }).supported, true);
  assert.equal(createProvider('win32').supported, false);
  assert.equal(unsupportedProvider.supported, false);
});

// -------------------------------------------------------------------- macOS ---

function macSetup(windows, { capture } = {}) {
  const calls = [];
  const dir = tmp();
  const exec = async (file, args) => {
    calls.push([file, args]);
    if (file.endsWith('osascript')) return JSON.stringify(windows);
    if (capture) return capture(file, args);
    fs.writeFileSync(args[args.length - 1], png());
    return '';
  };
  return { provider: createMacProvider({ exec, tmpdir: dir, selfPid: 1, platform: 'darwin' }), calls, dir };
}

test('mac: it takes the front-most ordinary window of the named app, by its window number', async () => {
  const { provider, calls } = macSetup([win({ owner: 'Mail', id: 1, title: 'Inbox' }), win({ id: 22, title: 'Front' }), win({ id: 21, title: 'Behind' })]);
  const shot = await provider.captureWindow('notes.app');
  assert.deepEqual([shot.width, shot.height], [600, 400]);
  const [, args] = calls.find((call) => call[0].endsWith('screencapture'));
  assert.deepEqual(args.slice(0, 6), ['-x', '-o', '-l', '22', '-t', 'png']);
});

test('mac: it never asks for the screen: no region, no display, only one window', async () => {
  const { provider, calls } = macSetup([win()]);
  await provider.captureWindow('Notes');
  const args = calls.find((call) => call[0].endsWith('screencapture'))[1];
  for (const forbidden of ['-R', '-S', '-s', '-i', '-m', '-D', '-C']) assert.ok(!args.includes(forbidden), forbidden);
  assert.ok(args.includes('-l'));
});

test('mac: menu-bar items, tiny, invisible and other apps\' windows are not the app\'s window', async () => {
  const { provider } = macSetup([win({ layer: 25 }), win({ w: 20, h: 20 }), win({ alpha: 0 }), win({ owner: 'Notes Helper' })]);
  await assert.rejects(() => provider.captureWindow('Notes'), (error) => error instanceof ProviderError && error.code === 'not_running');
});

test('mac: no permission shows as windows of other apps with no title, and nothing is captured', async () => {
  const { provider, calls } = macSetup([win({ title: '' }), win({ owner: 'Mail', id: 2, title: '' })]);
  await assert.rejects(() => provider.captureWindow('Notes'), (error) => error.code === 'permission' && /Screen Recording/.test(error.message));
  await assert.rejects(() => provider.appState('Notes'), (error) => error.code === 'permission');
  assert.equal(calls.some((call) => call[0].endsWith('screencapture')), false);
  // TheOne's own untitled windows say nothing about the permission, and an empty list is just "not running".
  const own = macSetup([win({ owner: 'TheOne', pid: 1, title: '' })]);
  await assert.rejects(() => own.provider.captureWindow('Notes'), (error) => error.code === 'not_running');
  await assert.rejects(() => macSetup([]).provider.captureWindow('Notes'), (error) => error.code === 'not_running');
});

test('mac: the temp file is removed, whether the capture worked or not', async () => {
  const ok = macSetup([win()]);
  await ok.provider.captureWindow('Notes');
  assert.deepEqual(fs.readdirSync(ok.dir), []);
  const notAPicture = macSetup([win()], { capture: async (file, args) => { fs.writeFileSync(args[args.length - 1], '<html>'.padEnd(100, 'x')); return ''; } });
  await assert.rejects(() => notAPicture.provider.captureWindow('Notes'), (error) => error.code === 'not_visible');
  assert.deepEqual(fs.readdirSync(notAPicture.dir), []);
  const failed = macSetup([win()], { capture: async () => { throw new Error('screencapture: could not create image from window'); } });
  await assert.rejects(() => failed.provider.captureWindow('Notes'), (error) => error.code === 'not_visible');
  const huge = macSetup([win()], { capture: async (file, args) => { fs.writeFileSync(args[args.length - 1], png(600, 400, 9 * 1024 * 1024)); return ''; } });
  await assert.rejects(() => huge.provider.captureWindow('Notes'), (error) => error.code === 'too_large');
  assert.deepEqual(fs.readdirSync(huge.dir), []);
});

test('mac: an unreadable window list is "unsupported", not a crash', async () => {
  const provider = createMacProvider({ exec: async () => 'not json', tmpdir: tmp(), platform: 'darwin' });
  await assert.rejects(() => provider.captureWindow('Notes'), (error) => error.code === 'unsupported');
  const failing = createMacProvider({ exec: async () => { throw new Error('osascript missing'); }, tmpdir: tmp(), platform: 'darwin' });
  await assert.rejects(() => failing.appState('Notes'), (error) => error.code === 'unsupported');
});

test('mac: the state of an app says whether it is running and in front, with its window titles', async () => {
  const { provider } = macSetup([win({ owner: 'Mail', id: 1 }), win({ id: 2, title: 'A' }), win({ id: 3, title: 'B' })]);
  assert.deepEqual(await provider.appState('Notes'), { running: true, frontmost: false, windows: ['A', 'B'] });
  assert.deepEqual(await provider.appState('Mail'), { running: true, frontmost: true, windows: ['Shopping'] });
  assert.equal((await provider.appState('Maps')).running, false);
});

// ------------------------------------------------------------------ Windows ---

function winSetup(windows, { foreground = 0, sources } = {}) {
  const exec = async () => JSON.stringify({ foreground, windows });
  const desktopCapturer = { getSources: async (options) => { desktopCapturer.options = options; return sources; } };
  return { provider: createWinProvider({ exec, desktopCapturer, platform: 'win32' }), desktopCapturer };
}
const wwin = (over) => ({ pid: 1, name: 'notepad', desc: 'Notepad', title: 'a.txt - Notepad', hwnd: 1234, w: 800, h: 600, minimized: false, visible: true, ...over });
const source = (hwnd, buffer = png(800, 600)) => ({ id: `window:${hwnd}:0`, thumbnail: { isEmpty: () => false, toPNG: () => buffer } });

test('windows: the window is found by process or display name and taken by its handle, not its title', async () => {
  const { provider, desktopCapturer } = winSetup([wwin({ hwnd: 1, name: 'other', desc: 'Other', title: 'a.txt - Notepad' }), wwin({ hwnd: 1234 })], { sources: [source(1), source(1234, png(800, 600))] });
  for (const name of ['Notepad', 'notepad', 'notepad.exe']) {
    const shot = await provider.captureWindow(name);
    assert.deepEqual([shot.width, shot.height], [800, 600]);
  }
  assert.deepEqual(desktopCapturer.options.types, ['window']);
  assert.ok(desktopCapturer.options.thumbnailSize.width <= 4096);
});

test('windows: a window that is minimized, missing or empty is not captured, with a reason', async () => {
  await assert.rejects(() => winSetup([wwin({ minimized: true })], { sources: [] }).provider.captureWindow('Notepad'), (error) => error.code === 'not_visible' && /minimized/.test(error.message));
  await assert.rejects(() => winSetup([], { sources: [] }).provider.captureWindow('Notepad'), (error) => error.code === 'not_running');
  await assert.rejects(() => winSetup([wwin()], { sources: [source(999)] }).provider.captureWindow('Notepad'), (error) => error.code === 'not_visible');
  const empty = { id: 'window:1234:0', thumbnail: { isEmpty: () => true, toPNG: () => png() } };
  await assert.rejects(() => winSetup([wwin()], { sources: [empty] }).provider.captureWindow('Notepad'), (error) => error.code === 'not_visible');
  await assert.rejects(() => winSetup([wwin()], { sources: [source(1234, Buffer.from('nope'))] }).provider.captureWindow('Notepad'), (error) => error.code === 'not_visible');
  await assert.rejects(() => winSetup([wwin()], { sources: [source(1234, png(800, 600, 9 * 1024 * 1024))] }).provider.captureWindow('Notepad'), (error) => error.code === 'too_large');
});

test('windows: tiny or hidden windows are ignored, and a lone window from PowerShell (not a list) is read', async () => {
  await assert.rejects(() => winSetup([wwin({ w: 10, h: 10 }), wwin({ visible: false })], { sources: [] }).provider.captureWindow('Notepad'), (error) => error.code === 'not_running');
  const provider = createWinProvider({ exec: async () => JSON.stringify({ foreground: 1234, windows: wwin() }), desktopCapturer: {}, platform: 'win32' });
  assert.deepEqual(await provider.appState('Notepad'), { running: true, frontmost: true, windows: ['a.txt - Notepad'] });
});

test('windows: a failing PowerShell is "unsupported", not a crash', async () => {
  const provider = createWinProvider({ exec: async () => { throw new Error('blocked by policy'); }, desktopCapturer: {}, platform: 'win32' });
  await assert.rejects(() => provider.captureWindow('Notepad'), (error) => error.code === 'unsupported');
});

// --------------------------------------------------------------- the actions ---

function actionsFor(provider) {
  const records = new RecordStore({ dir: tmp() });
  const sessions = new ComputerSessions();
  return createComputerActions({ settings: () => ({ enabled: true, apps: ['Notes'] }), provider, sessions, records });
}

test('a reason a provider gives is passed on in its own words; anything else is a generic failure that leaks nothing', async () => {
  const give = (error) => actionsFor({ supported: true, async captureWindow() { throw error; }, async appState() { throw error; } });
  const permission = await give(new ProviderError('permission', 'TheOne is not allowed to record the screen yet.')).screenshot({ app: 'Notes', sessionId: 'session_1', approved: true });
  assert.deepEqual([permission.status, permission.code], ['error', 'permission']);
  assert.match(permission.message, /not allowed to record/);
  const odd = await give(new Error('/Users/me/secret/path failed with token sk-abcdefghijklmnop')).screenshot({ app: 'Notes', sessionId: 'session_1', approved: true });
  assert.equal(odd.code, 'capture_failed');
  assert.doesNotMatch(JSON.stringify(odd), /secret|sk-/);
  const unknownCode = await give(new ProviderError('weird', 'internal detail')).screenshot({ app: 'Notes', sessionId: 'session_1', approved: true });
  assert.equal(unknownCode.code, 'capture_failed');
  assert.doesNotMatch(JSON.stringify(unknownCode), /internal detail/);
  const state = await give(new ProviderError('not_running', 'That application has no window on screen.')).state({ app: 'Notes' });
  assert.equal(state.code, 'not_running');
});

test('the whole way through, with a stand-in provider: needs approval, then a clean picture', async () => {
  const dir = tmp();
  const records = new RecordStore({ dir });
  const actions = createComputerActions({ settings: () => ({ enabled: true, apps: ['Notes'] }), provider: { supported: true, async captureWindow() { return { png: png(300, 200), width: 300, height: 200 }; }, async appState() { return { running: true, frontmost: true, windows: [] }; } }, sessions: new ComputerSessions(), records });
  assert.equal((await actions.screenshot({ app: 'Notes', sessionId: 'session_1' })).status, 'needs_approval');
  const shot = await actions.screenshot({ app: 'Notes', sessionId: 'session_1', approved: true });
  assert.equal(shot.status, 'ok');
  assert.deepEqual([shot.image.width, shot.image.height, shot.image.mime], [300, 200, 'image/png']);
  assert.equal(records.entries().length, 1);
});

// ------------------------------------------------------------ the contract ---

test('window capture is advertised to the page only on a system that has it', () => {
  assert.equal(SUPPORTED_CAPABILITIES.includes('computerReadV1'), false);
  assert.equal(bridgeContract(null).capabilities.includes('computerReadV1'), false);
  assert.equal(bridgeContract(null, { computerCapture: false }).capabilities.includes('computerReadV1'), false);
  assert.equal(bridgeContract(null, { computerCapture: true }).capabilities.includes('computerReadV1'), true);
});

test('the bridge picks the provider by system, and the permission page it opens is the system\'s screen-recording page only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
  assert.match(source, /createProvider\(process\.platform, \{ desktopCapturer \}\)/);
  assert.match(source, /computerCapture: computerProvider\.supported === true/);
  const handler = source.slice(source.indexOf("handle('desktop:computerOpenPermissionSettings'"), source.indexOf("handle('desktop:computerAddApp'"));
  assert.match(handler, /process\.platform !== 'darwin'\) return \{ opened: false \}/);
  assert.match(handler, /shell\.openExternal\('x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_ScreenCapture'\)/);
  assert.equal((handler.match(/openExternal/g) || []).length, 1);
  assert.match(source, /captureVerified: computerProvider\.supported === true && process\.platform === 'darwin'/);
});
