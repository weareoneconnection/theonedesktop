'use strict';

const { execFile } = require('node:child_process');
const { ProviderError, pngSize } = require('./provider');
const { normalizeApp } = require('./apps');

/**
 * Looking at one application's window on Windows: PowerShell lists the windows (process, name, handle, size,
 * whether it is minimized), and Electron's window capturer takes the picture of that one window, found by its
 * handle. Nothing captures the screen.
 *
 * NOT YET VERIFIED ON A WINDOWS COMPUTER. The macOS provider was checked on a real Mac; this one is written
 * against the documented behaviour of both pieces and tested with stand-ins, and stays marked unverified
 * until it has been run on Windows (a covered window, a minimized one, a window of another DPI scale).
 */

const MAX_BYTES = 8 * 1024 * 1024;
const MIN_WIDTH = 80;
const MIN_HEIGHT = 60;

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $r = New-Object W+RECT
  [void][W]::GetWindowRect($_.MainWindowHandle, [ref]$r)
  $d = ''
  try { $d = $_.MainModule.FileVersionInfo.FileDescription } catch {}
  [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; desc = $d; title = $_.MainWindowTitle; hwnd = [int64]$_.MainWindowHandle; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top); minimized = [W]::IsIconic($_.MainWindowHandle); visible = [W]::IsWindowVisible($_.MainWindowHandle) }
})
[pscustomobject]@{ foreground = [int64][W]::GetForegroundWindow(); windows = $windows } | ConvertTo-Json -Compress -Depth 4
`;

const run = (file, args, { timeout = 20000 } = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

// Names are compared without ".exe" and case, so "Notepad", "notepad" and "notepad.exe" are one name.
const nameOf = (value) => normalizeApp(String(value || '').replace(/\.exe$/i, ''));

function createWinProvider({ exec = run, desktopCapturer, platform = process.platform } = {}) {
  async function listWindows() {
    let raw;
    try {
      const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
      raw = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
    } catch { throw new ProviderError('unsupported', 'The window list could not be read.'); }
    try {
      const parsed = JSON.parse(String(raw).trim() || '{}');
      const windows = Array.isArray(parsed.windows) ? parsed.windows : parsed.windows ? [parsed.windows] : [];
      return { foreground: Number(parsed.foreground) || 0, windows: windows.filter((row) => row && Number.isFinite(Number(row.hwnd))) };
    } catch { throw new ProviderError('unsupported', 'The window list could not be read.'); }
  }
  const windowsOf = (all, app) => all.windows.filter((row) => row.visible !== false && Number(row.w) >= MIN_WIDTH && Number(row.h) >= MIN_HEIGHT && (nameOf(row.name) === nameOf(app) || nameOf(row.desc) === nameOf(app)));

  return {
    supported: platform === 'win32' && Boolean(desktopCapturer),
    reason: platform === 'win32' ? undefined : 'Window capture on this provider is for Windows only.',

    async appState(app) {
      const all = await listWindows();
      const mine = windowsOf(all, app);
      return { running: mine.length > 0, frontmost: mine.some((row) => Number(row.hwnd) === all.foreground), windows: mine.map((row) => String(row.title || '')).filter(Boolean).slice(0, 10) };
    },

    async captureWindow(app) {
      const all = await listWindows();
      const target = windowsOf(all, app)[0];
      if (!target) throw new ProviderError('not_running', 'That application has no window on screen. It may be closed or on another desktop.');
      if (target.minimized === true) throw new ProviderError('not_visible', 'That window is minimized; it cannot be captured until it is restored.');
      if (!desktopCapturer) throw new ProviderError('unsupported', 'unsupported');
      let sources;
      try {
        sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.min(Number(target.w), 4096), height: Math.min(Number(target.h), 4096) }, fetchWindowIcons: false });
      } catch { throw new ProviderError('not_visible', 'The window could not be captured.'); }
      // The source id of a window is `window:<handle>:0`: the handle, not a title, says which window it is.
      const source = (sources || []).find((item) => String(item.id).startsWith(`window:${Number(target.hwnd)}:`));
      if (!source || !source.thumbnail || (typeof source.thumbnail.isEmpty === 'function' && source.thumbnail.isEmpty())) {
        throw new ProviderError('not_visible', 'The window could not be captured.');
      }
      const png = source.thumbnail.toPNG();
      const size = pngSize(png);
      if (!size) throw new ProviderError('not_visible', 'The window could not be captured.');
      if (png.length > MAX_BYTES) throw new ProviderError('too_large', 'The picture is too large.');
      return { png, width: size.width, height: size.height };
    },

    listWindows,
  };
}

module.exports = { createWinProvider, SCRIPT };
