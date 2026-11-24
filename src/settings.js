'use strict';

/**
 * Settings on disk, in the app's data folder.
 *
 * The Anthropic and OpenAI keys are encrypted with Electron's safeStorage, which on macOS is
 * backed by a key in the login Keychain and on Windows by DPAPI: the file alone does not reveal it.
 */

const fs = require('node:fs');
const path = require('node:path');

class Settings {
  constructor({ dataDir, safeStorage }) {
    this.file = path.join(dataDir, 'settings.json');
    this.safeStorage = safeStorage;
    this.data = { workspaces: [], window: null, apiKey: '', terminal: { enabled: false, folders: [] } };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch { /* first run */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get workspaces() {
    return (this.data.workspaces || []).filter((folder) => fs.existsSync(folder));
  }

  addWorkspace(folder) {
    const list = [folder, ...(this.data.workspaces || []).filter((item) => item !== folder)].slice(0, 30);
    this.data.workspaces = list;
    this.save();
    return this.workspaces;
  }

  removeWorkspace(folder) {
    this.data.workspaces = (this.data.workspaces || []).filter((item) => item !== folder);
    this.save();
    return this.workspaces;
  }

  /**
   * The terminal (commands the chat runs in an opened folder): off until the
   * person turns it on here, and then only for the folders they name. Both
   * choices are made in a native dialog the page cannot draw (bridge.js).
   */
  get terminal() {
    const saved = this.data.terminal && typeof this.data.terminal === 'object' ? this.data.terminal : {};
    const opened = new Set(this.workspaces);
    // A folder that is no longer opened loses its terminal with it.
    const folders = (Array.isArray(saved.folders) ? saved.folders : []).filter((folder) => opened.has(folder));
    return { enabled: saved.enabled === true, folders };
  }

  setTerminalEnabled(enabled) {
    const current = this.terminal;
    this.data.terminal = { enabled: Boolean(enabled), folders: enabled ? current.folders : [] };
    this.save();
    return this.terminal;
  }

  setTerminalFolder(folder, on) {
    const value = String(folder || '');
    if (!this.workspaces.includes(value)) throw new Error('That folder is not opened in TheOne.');
    const current = this.terminal;
    const folders = on ? [value, ...current.folders.filter((item) => item !== value)] : current.folders.filter((item) => item !== value);
    this.data.terminal = { enabled: current.enabled, folders };
    this.save();
    return this.terminal;
  }

  get hasOpenAIKey() {
    return Boolean(this.data.openaiApiKey);
  }

  getOpenAIKey() {
    return this.decrypt(this.data.openaiApiKey);
  }

  setOpenAIKey(value) {
    this.data.openaiApiKey = this.encrypt(value);
    this.save();
  }

  get codexUsesApiKey() {
    return Boolean(this.data.codexUsesApiKey);
  }

  set codexUsesApiKey(value) {
    this.data.codexUsesApiKey = Boolean(value);
    this.save();
  }

  /** What the runtime is started with: the Anthropic key, the OpenAI key, how Codex signs in, and whether the terminal is on. */
  runtimeArgs() {
    return [this.devApiKey || this.getApiKey(), this.getOpenAIKey(), this.codexUsesApiKey, this.terminal.enabled];
  }

  decrypt(stored) {
    if (!stored || !this.safeStorage.isEncryptionAvailable()) return '';
    try {
      return this.safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      return '';
    }
  }

  encrypt(value) {
    if (!value) return '';
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available on this computer; the key was not saved.');
    return this.safeStorage.encryptString(value).toString('base64');
  }

  get hasApiKey() {
    return Boolean(this.devApiKey || this.data.apiKey);
  }

  getApiKey() {
    if (!this.data.apiKey) return '';
    if (!this.safeStorage.isEncryptionAvailable()) return '';
    try {
      return this.safeStorage.decryptString(Buffer.from(this.data.apiKey, 'base64'));
    } catch {
      return '';
    }
  }

  setApiKey(value) {
    if (!value) {
      this.data.apiKey = '';
    } else {
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available on this computer; the key was not saved.');
      this.data.apiKey = this.safeStorage.encryptString(value).toString('base64');
    }
    this.save();
  }

  get windowBounds() {
    return this.data.window;
  }

  set windowBounds(bounds) {
    this.data.window = bounds;
    this.save();
  }
}

module.exports = { Settings };
