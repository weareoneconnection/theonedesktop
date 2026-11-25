'use strict';

/**
 * Settings on disk, in the app's data folder.
 *
 * The Anthropic and OpenAI keys are encrypted with Electron's safeStorage, which on macOS is
 * backed by a key in the login Keychain and on Windows by DPAPI: the file alone does not reveal it.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

  // ------------------------------------------------------------------- files ---
  // File management (move, copy, rename, make a folder, send to the trash) in opened folders the person
  // turned it on for. Off until turned on here; both choices are confirmed in a native dialog (bridge.js).

  get files() {
    const saved = this.data.files && typeof this.data.files === 'object' ? this.data.files : {};
    const opened = new Set(this.workspaces);
    const folders = (Array.isArray(saved.folders) ? saved.folders : []).filter((folder) => opened.has(folder));
    return { enabled: saved.enabled === true, folders };
  }

  setFilesEnabled(enabled) {
    const current = this.files;
    this.data.files = { enabled: Boolean(enabled), folders: enabled ? current.folders : [] };
    this.save();
    return this.files;
  }

  setFilesFolder(folder, on) {
    const value = String(folder || '');
    if (!this.workspaces.includes(value)) throw new Error('That folder is not opened in TheOne.');
    const current = this.files;
    const folders = on ? [value, ...current.folders.filter((item) => item !== value)] : current.folders.filter((item) => item !== value);
    this.data.files = { enabled: current.enabled, folders };
    this.save();
    return this.files;
  }

  // ---------------------------------------------------------------- computer use ---
  // Letting TheOne look at chosen applications: off until the person turns it on here, and then
  // only the applications they add one by one. Both are confirmed in a native dialog (bridge.js).

  get computer() {
    const saved = this.data.computer && typeof this.data.computer === 'object' ? this.data.computer : {};
    const apps = (Array.isArray(saved.apps) ? saved.apps : []).filter((app) => typeof app === 'string' && app && app.length <= 80);
    // Acting (click, type) is its own choice, off by default, and only ever on while looking is.
    return { enabled: saved.enabled === true, allowInput: saved.enabled === true && saved.allowInput === true, apps: [...new Set(apps)].slice(0, 20), retentionDays: Number.isInteger(saved.retentionDays) && saved.retentionDays >= 1 && saved.retentionDays <= 30 ? saved.retentionDays : 7 };
  }

  /** Turning it off forgets the apps: they have to be added again, each with its own confirmation. */
  setComputerEnabled(enabled) {
    const current = this.computer;
    this.data.computer = { enabled: Boolean(enabled), allowInput: false, apps: enabled ? current.apps : [], retentionDays: current.retentionDays };
    this.save();
    return this.computer;
  }

  setComputerInput(allow) {
    const current = this.computer;
    if (!current.enabled) throw new Error('Computer use is off.');
    this.data.computer = { ...current, allowInput: Boolean(allow) };
    this.save();
    return this.computer;
  }

  /** `name` is a validated application name (computer/apps.js). */
  addComputerApp(name) {
    const current = this.computer;
    if (!current.enabled) throw new Error('Computer use is off.');
    this.data.computer = { ...current, apps: [name, ...current.apps.filter((app) => app !== name)].slice(0, 20) };
    this.save();
    return this.computer;
  }

  removeComputerApp(name) {
    const current = this.computer;
    this.data.computer = { ...current, apps: current.apps.filter((app) => app !== name) };
    this.save();
    return this.computer;
  }

  // --------------------------------------------------------------- MCP servers ---
  // Programs the person added to give TheOne more tools. Kept on this computer only. A server's
  // environment values (tokens) are encrypted like the API keys; what the person approved of it —
  // which tools, and the digest of exactly the tool list they were shown — is stored with it.

  /** The servers without their secrets: what a settings page may see. */
  get mcpServers() {
    const saved = this.data.mcp && Array.isArray(this.data.mcp.servers) ? this.data.mcp.servers : [];
    return saved.filter((server) => server && typeof server.id === 'string' && typeof server.name === 'string').map((server) => ({
      id: server.id, name: server.name, command: String(server.command || ''), args: Array.isArray(server.args) ? server.args.map(String) : [],
      envNames: Object.keys(server.env && typeof server.env === 'object' ? server.env : {}), enabled: server.enabled === true,
      approvedDigest: typeof server.approvedDigest === 'string' ? server.approvedDigest : '',
      enabledTools: Array.isArray(server.enabledTools) ? server.enabledTools.map(String) : [],
      // The definitions the person was shown for the tools they turned on: what the model is given.
      approvedTools: Array.isArray(server.approvedTools) ? server.approvedTools.filter((tool) => tool && typeof tool.name === 'string').map((tool) => ({ name: tool.name, description: String(tool.description || ''), inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' } })) : [],
    }));
  }

  mcpEnv(id) {
    const server = ((this.data.mcp && this.data.mcp.servers) || []).find((item) => item && item.id === id);
    const out = {};
    for (const [key, stored] of Object.entries((server && server.env) || {})) out[key] = this.decrypt(stored);
    return out;
  }

  /** What the MCP manager reads. */
  mcpStore() {
    return { list: () => this.mcpServers, get: (id) => this.mcpServers.find((server) => server.id === id) || null, env: (id) => this.mcpEnv(id) };
  }

  /** `def` is a validated definition (mcp/config.js). A server starts turned off, with nothing approved. */
  addMcpServer(def) {
    const env = {};
    for (const [key, value] of Object.entries(def.envValues || {})) env[key] = this.encrypt(value);
    const id = `srv_${crypto.randomBytes(6).toString('hex')}`;
    const servers = (this.data.mcp && this.data.mcp.servers) || [];
    this.data.mcp = { servers: [...servers, { id, name: def.name, command: def.command, args: def.args, env, enabled: false, approvedDigest: '', enabledTools: [] }] };
    this.save();
    return id;
  }

  removeMcpServer(id) {
    const servers = (this.data.mcp && this.data.mcp.servers) || [];
    this.data.mcp = { servers: servers.filter((server) => server.id !== id) };
    this.save();
  }

  updateMcpServer(id, change) {
    const servers = (this.data.mcp && this.data.mcp.servers) || [];
    if (!servers.some((server) => server.id === id)) throw new Error('That server does not exist.');
    this.data.mcp = { servers: servers.map((server) => (server.id === id ? { ...server, ...change } : server)) };
    this.save();
  }

  setMcpEnabled(id, enabled) {
    // Turning a server off forgets the approval: it must be looked at again when it is turned on.
    this.updateMcpServer(id, enabled ? { enabled: true } : { enabled: false, approvedDigest: '', enabledTools: [], approvedTools: [] });
  }

  /** `definitions` are the tool definitions of exactly the list that was shown; only those turned on are kept. */
  setMcpTools(id, enabledTools, approvedDigest, definitions = []) {
    const names = [...new Set(enabledTools.map(String))];
    const approvedTools = definitions.filter((tool) => names.includes(tool.name)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    this.updateMcpServer(id, { enabledTools: names, approvedDigest: String(approvedDigest || ''), approvedTools });
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
