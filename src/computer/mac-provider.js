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
  out.push({ owner: w.kCGWindowOwnerName || '', pid: w.kCGWindowOwnerPID, id: w.kCGWindowNumber, title: w.kCGWindowName || '', layer: w.kCGWindowLayer, alpha: w.kCGWindowAlpha, w: b.Width || 0, h: b.Height || 0 });
}
JSON.stringify(out);
`;

const run = (file, args, { timeout = 15000 } = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
});

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
        return { png, width: size.width, height: size.height };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('not_visible', 'The window could not be captured.');
      } finally {
        try { fs.rmSync(file, { force: true }); } catch { /* a temp file that is already gone */ }
      }
    },

    // For tests and the settings page.
    listWindows,
  };
}

module.exports = { createMacProvider, LIST_WINDOWS };
