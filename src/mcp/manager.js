'use strict';

/**
 * Keeps the person's MCP servers: starts one when it is needed, stops it when it is not, and
 * decides — before anything is sent to it — whether a call is allowed at all:
 *
 *   - the server is enabled, and not failed
 *   - the tool is one the person turned on
 *   - the tools the server lists right now are exactly the ones the person was shown
 *     (a server that changes a name, a description or a schema after approval is stopped)
 *
 * Every call, allowed or not, is written to the audit.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { McpConnection, McpError } = require('./client');
const { toolListDigest, redactText, cleanText } = require('./sanitize');
const { buildChildEnv, serverWorkingDirectory } = require('./config');

const DEFAULTS = {
  idleMs: 5 * 60_000, crashWindowMs: 10 * 60_000, maxCrashes: 3, maxConcurrent: 4, maxQueue: 20,
  requestTimeoutMs: 60_000, initTimeoutMs: 20_000,
};

class McpManager {
  /**
   * `store` is what the manager reads about servers: list(), get(id), env(id) (decrypted values) —
   * kept as an interface so settings can be encrypted storage and tests can be a plain object.
   */
  constructor({ store, dataDir, pathValue = () => process.env.PATH, audit = () => undefined, now = Date.now, limits = {}, spawnFn, childEnv = buildChildEnv } = {}) {
    this.store = store;
    this.dataDir = dataDir;
    this.pathValue = pathValue;
    this.audit = audit;
    this.now = now;
    this.limits = { ...DEFAULTS, ...limits };
    this.spawnFn = spawnFn;
    this.childEnv = childEnv;
    this.runtime = new Map();
  }

  state(id) {
    let state = this.runtime.get(id);
    if (!state) {
      state = { conn: null, starting: null, idleTimer: null, crashes: [], failed: false, changed: false, active: 0, queue: [], lastError: '' };
      this.runtime.set(id, state);
    }
    return state;
  }

  status(id) {
    const state = this.state(id);
    return { running: Boolean(state.conn && state.conn.alive), failed: state.failed, changed: state.changed, active: state.active, queued: state.queue.length, lastError: state.lastError };
  }

  /** The person has dealt with what went wrong (restarted a failed server, accepted a changed tool list). */
  reset(id) {
    const state = this.state(id);
    state.failed = false;
    state.changed = false;
    state.crashes = [];
    state.lastError = '';
  }

  async connect(id) {
    const state = this.state(id);
    if (state.conn && state.conn.alive) { this.touch(id); return state.conn; }
    if (state.starting) return state.starting;
    const server = this.store.get(id);
    if (!server) throw new McpError('That server does not exist.', 'unknown_server');
    if (server.enabled !== true) throw new McpError('That server is turned off.', 'disabled');
    if (state.failed) throw new McpError('That server keeps crashing and was stopped. Restart it from settings.', 'failed');
    if (process.platform === 'win32') throw new McpError('MCP servers are not supported on Windows yet.', 'unsupported_platform');
    const cwd = serverWorkingDirectory(this.dataDir, server.name);
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const conn = new McpConnection({
      command: server.command, args: server.args, cwd,
      env: this.childEnv({ declared: this.store.env(id), pathValue: this.pathValue() }),
      clientInfo: { name: 'theone-desktop', version: '0' },
      spawnFn: this.spawnFn, initTimeoutMs: this.limits.initTimeoutMs, requestTimeoutMs: this.limits.requestTimeoutMs,
      onExit: (info) => this.onExit(id, conn, info),
      // A "list changed" notice is not an accusation: the list is read again before the next call
      // (conn.toolsChanged), and only a list that differs from the approved one stops the server.
    });
    state.starting = conn.start().then(() => { state.conn = conn; state.starting = null; this.touch(id); return conn; }, (error) => {
      state.starting = null;
      state.lastError = cleanText(error && error.message, 200);
      throw error;
    });
    return state.starting;
  }

  onExit(id, conn, info) {
    const state = this.state(id);
    if (state.conn === conn) state.conn = null;
    clearTimeout(state.idleTimer);
    if (info.closing) return;
    const at = this.now();
    state.crashes = state.crashes.filter((time) => at - time < this.limits.crashWindowMs);
    state.crashes.push(at);
    state.lastError = `The server exited (${info.signal || `code ${info.code}`}).`;
    if (state.crashes.length > this.limits.maxCrashes) state.failed = true;
  }

  touch(id) {
    const state = this.state(id);
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => { void this.stop(id); }, this.limits.idleMs);
    if (state.idleTimer.unref) state.idleTimer.unref();
  }

  async stop(id) {
    const state = this.state(id);
    clearTimeout(state.idleTimer);
    const conn = state.conn;
    state.conn = null;
    if (conn) await conn.close();
  }

  async stopAll() {
    await Promise.all([...this.runtime.keys()].map((id) => this.stop(id)));
  }

  /**
   * Connect and list what the server offers, for the person to look at and choose from. The
   * digest identifies exactly this list; approving tools records it.
   */
  async discover(id) {
    const conn = await this.connect(id);
    const { tools, dropped } = await conn.listTools();
    return { tools, dropped, digest: toolListDigest(tools), serverInfo: conn.serverInfo, protocolVersion: conn.protocolVersion };
  }

  async slot(id) {
    const state = this.state(id);
    if (state.active < this.limits.maxConcurrent) { state.active += 1; return; }
    if (state.queue.length >= this.limits.maxQueue) throw new McpError('The server is busy; try again in a moment.', 'busy');
    await new Promise((resolve) => state.queue.push(resolve));
  }

  release(id) {
    const state = this.state(id);
    const next = state.queue.shift();
    if (next) next(); else state.active -= 1;
  }

  /**
   * Call one tool the person approved. Refused, without anything being sent, when the server is
   * off or failed, when the tool was not turned on, or when what the server lists now is not what
   * the person approved.
   */
  async call(id, tool, args, { signal, by = 'unknown' } = {}) {
    const started = this.now();
    const server = this.store.get(id);
    const record = (outcome, extra = {}) => this.audit({
      at: new Date(started).toISOString(), server: server ? server.name : String(id).slice(0, 40), tool: String(tool).slice(0, 80), by, outcome,
      argsDigest: crypto.createHash('sha256').update(JSON.stringify(args ?? null) || '').digest('hex'),
      argsPreview: redactText(JSON.stringify(args ?? null) || '').slice(0, 200), ms: this.now() - started, ...extra,
    });
    try {
      if (!server) throw new McpError('That server does not exist.', 'unknown_server');
      if (server.enabled !== true) throw new McpError('That server is turned off.', 'disabled');
      if (!(server.enabledTools || []).includes(tool)) throw new McpError('That tool is not turned on.', 'tool_not_enabled');
      if (!server.approvedDigest) throw new McpError('That server has no approved tool list. Review its tools in settings first.', 'not_approved');
      const state = this.state(id);
      if (state.changed) throw new McpError('That server changed its tools since you approved them. Review them in settings.', 'changed');
      await this.slot(id);
      try {
        const conn = await this.connect(id);
        // Checked on every connection and whenever the server says its list changed: what it
        // says now must be exactly what the person was shown.
        if (!conn.verifiedDigest || conn.toolsChanged) {
          const { tools } = await conn.listTools();
          if (toolListDigest(tools) !== server.approvedDigest) {
            state.changed = true;
            await this.stop(id);
            throw new McpError('That server changed its tools since you approved them. Review them in settings.', 'changed');
          }
          conn.verifiedDigest = true;
        }
        const result = await conn.callTool(tool, args, { signal });
        this.touch(id);
        record(result.isError ? 'tool_error' : 'ok', { resultDigest: crypto.createHash('sha256').update(result.text).digest('hex') });
        return result;
      } finally {
        this.release(id);
      }
    } catch (error) {
      record('refused_or_failed', { code: error && error.code ? error.code : 'error', message: cleanText(error && error.message, 200) });
      throw error;
    }
  }
}

module.exports = { McpManager, DEFAULTS };
