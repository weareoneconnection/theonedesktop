'use strict';

/**
 * Settings on disk, in the app's data folder.
 *
 * The Anthropic and OpenAI keys are encrypted with Electron's safeStorage, which on macOS is
 * backed by a key in the login Keychain: the file alone does not reveal it.
 */

const fs = require('node:fs');
const path = require('node:path');

class Settings {
  constructor({ dataDir, safeStorage }) {
    this.file = path.join(dataDir, 'settings.json');
    this.safeStorage = safeStorage;
    this.data = { workspaces: [], window: null, apiKey: '' };
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

  /** What the runtime is started with: the Anthropic key, the OpenAI key, and how Codex signs in. */
  runtimeArgs() {
    return [this.devApiKey || this.getApiKey(), this.getOpenAIKey(), this.codexUsesApiKey];
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
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available on this Mac; the key was not saved.');
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
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available on this Mac; the key was not saved.');
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
