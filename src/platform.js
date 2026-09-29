'use strict';

/**
 * What differs between macOS and Windows, in one place.
 *
 * The app was written on a Mac: a title bar hidden behind the traffic lights,
 * a login shell to read PATH from, ":" between PATH entries, /bin/sh for the
 * agent's commands. On Windows the window keeps its own frame, PATH uses ";",
 * child processes need the system variables Windows itself relies on, and the
 * agent's shell is Git Bash (bundled with Git for Windows), so the same
 * commands run the same way. Without Git Bash the local engines say what is
 * missing; cloud tasks are unaffected.
 */

const fs = require('node:fs');
const path = require('node:path');

const isWindows = (platform = process.platform) => platform === 'win32';

/** BrowserWindow options for the frame. */
function windowChrome(platform = process.platform) {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 17 } };
  // Windows and Linux: the system frame, with its own minimise, maximise and close.
  return { autoHideMenuBar: true };
}

function delimiter(platform = process.platform) {
  return isWindows(platform) ? ';' : ':';
}

/** PATH entries from several sources, first wins, in the platform's form. Windows compares case-insensitively. */
function mergePath(platform, ...sources) {
  const sep = delimiter(platform);
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    for (const entry of String(source || '').split(sep)) {
      const item = entry.trim();
      const key = isWindows(platform) ? item.toLowerCase() : item;
      if (item && !seen.has(key)) { seen.add(key); out.push(item); }
    }
  }
  return out.join(sep);
}

/** The usual install places, for an app started without a login shell's PATH. */
function fallbackPath(platform = process.platform, env = process.env) {
  if (!isWindows(platform)) return '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  return [
    path.win32.join(programFiles, 'Git', 'cmd'),
    path.win32.join(programFiles, 'Git', 'usr', 'bin'),
    path.win32.join(programFiles, 'nodejs'),
    env.APPDATA ? path.win32.join(env.APPDATA, 'npm') : '',
    env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32') : 'C:\\Windows\\System32',
  ].filter(Boolean).join(';');
}

/** Git Bash, for the agent's shell commands on Windows; null when Git for Windows is not installed. */
function gitBash(env = process.env, exists = fs.existsSync) {
  const candidates = [
    env.ONECLAW_SHELL,
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env.ProgramW6432 && path.win32.join(env.ProgramW6432, 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate)) || null;
}

/** Where local tasks may work: the whole disk on a Mac, every drive on Windows (the folder picker is the real gate). */
function workspaceRoots(platform = process.platform, exists = fs.existsSync) {
  if (!isWindows(platform)) return '/';
  const drives = [];
  for (let code = 67; code <= 90; code += 1) { // C: to Z:
    const root = `${String.fromCharCode(code)}:\\`;
    if (exists(root)) drives.push(root);
  }
  return (drives.length ? drives : ['C:\\']).join(',');
}

/** The variables a Windows child process needs besides PATH; nothing elsewhere. */
function systemEnv(platform = process.platform, env = process.env) {
  if (!isWindows(platform)) return {};
  const names = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];
  return Object.fromEntries(names.filter((name) => env[name]).map((name) => [name, env[name]]));
}

/** Executable names to look for on the PATH: codex, or codex.exe / codex.cmd on Windows. */
function executableNames(name, platform = process.platform, env = process.env) {
  if (!isWindows(platform)) return [name];
  const extensions = String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((ext) => ext.toLowerCase());
  return extensions.map((ext) => `${name}${ext}`);
}

module.exports = { delimiter, executableNames, fallbackPath, gitBash, isWindows, mergePath, systemEnv, windowChrome, workspaceRoots };
