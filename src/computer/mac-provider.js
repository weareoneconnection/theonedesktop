'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { ProviderError, pngSize } = require('./provider');
const { normalizeApp } = require('./apps');

/**
 * Looking at one application's window on macOS, built on two things the system already has: the window list
 * (CoreGraphics, read through osascript) to find the app's window, and `screencapture -l <window>` to take
 * that one window. The system composes the window's own picture, so what lies on top of it is not in it
 * (checked on macOS 26 with two overlapping windows). Nothing here captures the screen.
 *
 * It needs the Screen Recording permission for TheOne. Without it other apps' windows have no title in the
 * list, which is how it is noticed; the capture is then not tried.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const MIN_WIDTH = 80;
const MIN_HEIGHT = 60;

// Front to back, as the system lists them. One JSON line out.
const LIST_WINDOWS = `
ObjC.import('CoreGraphics');
const info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
const arr = ObjC.castRefToObject(info);
const out = [];
for (let i = 0; i < arr.count; i += 1) {
  const w = ObjC.deepUnwrap(arr.objectAtIndex(i));
  const b = w.kCGWindowBounds || {};
  out.push({ owner: w.kCGWindowOwnerName || '', pid: w.kCGWindowOwnerPID, id: w.kCGWindowNumber, title: w.kCGWindowName || '', layer: w.kCGWindowLayer, alpha: w.kCGWindowAlpha, x: b.X || 0, y: b.Y || 0, w: b.Width || 0, h: b.Height || 0 });
}
JSON.stringify(out);
`;

const run = (file, args, { timeout = 15000 } = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
});

// Keys by their macOS virtual key code.
const KEY_CODES = { return: 36, tab: 48, escape: 53, space: 49, delete: 51, left: 123, right: 124, down: 125, up: 126 };

// Events go to one process (CGEventPostToPid), never to the whole system, so a window on top cannot take them. macOS
// drops them without any error unless the app is allowed under Accessibility: `trusted` is checked first, always.
const jxa = (body) => `ObjC.import('CoreGraphics'); ObjC.import('ApplicationServices'); ${body}`;
const trustScript = jxa('JSON.stringify({ trusted: $.AXIsProcessTrusted() });');
const clickScript = (pid, x, y, double) => jxa(`
const pid = ${Number(pid)}; const p = { x: ${Number(x)}, y: ${Number(y)} };
const post = (type, state) => { const e = $.CGEventCreateMouseEvent(null, type, p, 0); $.CGEventSetIntegerValueField(e, 1, state); $.CGEventPostToPid(pid, e); };
post(5, 0); delay(0.05);
post(1, 1); delay(0.04); post(2, 1);
${double ? 'delay(0.06); post(1, 2); delay(0.04); post(2, 2);' : ''}
'ok';`);
const typeScript = (pid, text) => jxa(`
const pid = ${Number(pid)};
for (const ch of Array.from(${JSON.stringify(String(text))})) {
  const down = $.CGEventCreateKeyboardEvent(null, 0, true); $.CGEventKeyboardSetUnicodeString(down, ch.length, ch);
  const up = $.CGEventCreateKeyboardEvent(null, 0, false); $.CGEventKeyboardSetUnicodeString(up, ch.length, ch);
  $.CGEventPostToPid(pid, down); delay(0.02); $.CGEventPostToPid(pid, up); delay(0.02);
}
'ok';`);
const keyScript = (pid, code) => jxa(`
const pid = ${Number(pid)};
const down = $.CGEventCreateKeyboardEvent(null, ${Number(code)}, true); const up = $.CGEventCreateKeyboardEvent(null, ${Number(code)}, false);
$.CGEventPostToPid(pid, down); delay(0.03); $.CGEventPostToPid(pid, up);
'ok';`);

function createMacProvider({ exec = run, tmpdir = os.tmpdir(), selfPid = process.pid, platform = process.platform } = {}) {
  async function listWindows() {
    let raw;
    try { raw = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', LIST_WINDOWS]); } catch { throw new ProviderError('unsupported', 'The window list could not be read.'); }
    try {
      const rows = JSON.parse(String(raw).trim());
      return Array.isArray(rows) ? rows.filter((row) => row && Number.isInteger(row.id)) : [];
    } catch { throw new ProviderError('unsupported', 'The window list could not be read.'); }
  }

  // Ordinary windows of the named app, front-most first.
  const windowsOf = (all, app) => all.filter((row) => row.layer === 0 && row.alpha !== 0 && row.w >= MIN_WIDTH && row.h >= MIN_HEIGHT && normalizeApp(row.owner) === normalizeApp(app));

  // Without the permission other apps' windows are listed with no title.
  function assertPermission(all) {
    const others = all.filter((row) => row.layer === 0 && row.pid !== selfPid && row.owner);
    if (others.length && others.every((row) => !row.title)) {
      throw new ProviderError('permission', 'TheOne is not allowed to record the screen yet. The person can allow it in System Settings → Privacy & Security → Screen Recording.');
    }
  }

  return {
    supported: platform === 'darwin',
    reason: platform === 'darwin' ? undefined : 'Window capture on this provider is for macOS only.',

    async appState(app) {
      const all = await listWindows();
      assertPermission(all);
      const mine = windowsOf(all, app);
      const front = all.find((row) => row.layer === 0 && row.owner);
      return { running: mine.length > 0, frontmost: Boolean(front) && normalizeApp(front.owner) === normalizeApp(app), windows: mine.map((row) => row.title).filter(Boolean).slice(0, 10) };
    },

    async captureWindow(app) {
      const all = await listWindows();
      assertPermission(all);
      const target = windowsOf(all, app)[0];
      if (!target) throw new ProviderError('not_running', 'That application has no window on screen. It may be closed, minimized or on another desktop.');
      const file = path.join(tmpdir, `theone-shot-${crypto.randomBytes(8).toString('hex')}.png`);
      try {
        // -x no sound, -o no shadow, -l this window only.
        await exec('/usr/sbin/screencapture', ['-x', '-o', '-l', String(target.id), '-t', 'png', file]);
        const png = fs.readFileSync(file);
        const size = pngSize(png);
        if (!size) throw new ProviderError('not_visible', 'The window could not be captured.');
        if (png.length > MAX_BYTES) throw new ProviderError('too_large', 'The picture is too large.');
        // `window` is where the window stood when it was taken: a click is placed on that picture and checked against it.
        return { png, width: size.width, height: size.height, window: { id: target.id, pid: target.pid, x: target.x, y: target.y, w: target.w, h: target.h, title: target.title || '' } };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('not_visible', 'The window could not be captured.');
      } finally {
        try { fs.rmSync(file, { force: true }); } catch { /* a temp file that is already gone */ }
      }
    },

    /** The app's front-most window as it is now (no picture): where it is, for checking a click still means what it did. */
    async findWindow(app) {
      const all = await listWindows();
      assertPermission(all);
      const target = windowsOf(all, app)[0];
      return target ? { id: target.id, pid: target.pid, x: target.x, y: target.y, w: target.w, h: target.h, title: target.title || '' } : null;
    },

    input: {
      supported: platform === 'darwin',
      /** Whether macOS lets this app send events to others (Accessibility). Without it they are dropped silently. */
      async trusted() {
        try { return JSON.parse(String(await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', trustScript])).trim()).trusted === true; } catch { return false; }
      },
      async click(window, point, { double = false } = {}) {
        await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', clickScript(window.pid, point.x, point.y, double)]);
      },
      async type(window, text) {
        await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', typeScript(window.pid, text)], { timeout: 30000 });
      },
      async key(window, name) {
        if (!(name in KEY_CODES)) throw new ProviderError('unsupported', 'That key cannot be pressed.');
        await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', keyScript(window.pid, KEY_CODES[name])]);
      },
    },

    // For tests and the settings page.
    listWindows,
  };
}

module.exports = { createMacProvider, LIST_WINDOWS };
