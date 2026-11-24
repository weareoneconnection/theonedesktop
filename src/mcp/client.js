'use strict';

/**
 * A minimal MCP client over stdio: newline-delimited JSON-RPC 2.0 to a program the person chose.
 *
 * Only what is needed is implemented — initialize, tools/list, tools/call, cancellation, ping and
 * the tools list-changed notice — and everything the server says is treated as untrusted input:
 * messages are size-limited and validated, a server that talks nonsense is stopped, replies to
 * requests we never made are ignored, and every request has a deadline. The server gets no
 * capabilities from us (no roots, no sampling, no elicitation), so any request it makes of us
 * other than `ping` is answered "method not found".
 *
 * (Why not the official SDK: for a stdio client it pulls in an HTTP server stack — express, hono,
 * jose and more — and a 4.5 MB package into an app whose only runtime dependency is its updater.
 * The protocol is isolated here so it can be swapped.)
 */

const { spawn } = require('node:child_process');
const { cleanText, normalizeTool, redactText, keepEnds, MAX_OUTPUT_CHARS } = require('./sanitize');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_INVALID_LINES = 20;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_LIST_PAGES = 20;
const STDERR_KEEP = 4096;

class McpError extends Error {
  constructor(message, code = 'mcp_error', data) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

class McpConnection {
  constructor({
    command, args = [], cwd, env = {}, clientInfo = { name: 'theone-desktop', version: '0' },
    spawnFn = spawn, initTimeoutMs = 20_000, requestTimeoutMs = 60_000, maxTools = 100, onExit, onToolsChanged,
  }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.clientInfo = clientInfo;
    this.spawnFn = spawnFn;
    this.initTimeoutMs = initTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxTools = maxTools;
    this.onExit = onExit;
    this.onToolsChanged = onToolsChanged;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.invalidLines = 0;
    this.stderrTail = '';
    this.closing = false;
    this.exited = false;
    this.toolsChanged = false;
    this.serverInfo = null;
    this.protocolVersion = null;
  }

  get alive() { return Boolean(this.child) && !this.exited && !this.closing; }

  /** Start the program and finish the handshake. Rejects, and leaves nothing running, if it fails. */
  async start() {
    try {
      this.child = this.spawnFn(this.command, this.args, {
        cwd: this.cwd, env: this.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so closing it ends everything it started.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      throw new McpError(`Could not start the server: ${cleanText(error && error.message, 200)}`, 'spawn_failed');
    }
    const child = this.child;
    const started = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => reject(new McpError(`Could not start the server: ${cleanText(error && error.message, 200)}`, 'spawn_failed')));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_KEEP); });
    child.stdin.on('error', () => { /* the exit handler reports it */ });
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.on('error', (error) => { if (!this.exited) this.handleExit(null, `error: ${error && error.message}`); });
    try {
      await started;
      const result = await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: this.clientInfo,
      }, this.initTimeoutMs, { cancellable: false });
      if (!result || typeof result !== 'object' || !PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
        throw new McpError(`The server speaks an unsupported protocol version (${cleanText(result && result.protocolVersion, 40) || 'none'}).`, 'unsupported_protocol');
      }
      if (!result.capabilities || typeof result.capabilities !== 'object' || !result.capabilities.tools) {
        throw new McpError('The server offers no tools.', 'no_tools');
      }
      this.protocolVersion = result.protocolVersion;
      const info = result.serverInfo && typeof result.serverInfo === 'object' ? result.serverInfo : {};
      this.serverInfo = { name: cleanText(info.name, 80), version: cleanText(info.version, 40) };
      this.notify('notifications/initialized');
    } catch (error) {
      await this.close();
      throw error instanceof McpError ? error : new McpError(cleanText(error && error.message, 200) || 'handshake failed', 'handshake_failed');
    }
    return this;
  }

  // ------------------------------------------------------------- framing ---

  onData(chunk) {
    if (this.closing) return;
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      if (this.closing) return;
    }
    // A message with no end in sight: the server is not speaking the protocol (or is trying to exhaust memory).
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
      this.violation('The server sent a message larger than the limit.');
    }
  }

  onLine(line) {
    if (line.length > MAX_LINE_BYTES) return this.violation('The server sent a message larger than the limit.');
    let message;
    try { message = JSON.parse(line); } catch { return this.noise(); }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') return this.noise();
    const hasId = message.id !== undefined && message.id !== null;
    const isMethod = typeof message.method === 'string';
    if (hasId && !isMethod) return this.onResponse(message);
    if (hasId && isMethod) return this.onServerRequest(message);
    if (isMethod) return this.onNotification(message);
    return this.noise();
  }

  noise() {
    this.invalidLines += 1;
    if (this.invalidLines > MAX_INVALID_LINES) this.violation('The server sent too many malformed messages.');
  }

  violation(reason) {
    this.violationReason = reason;
    void this.close();
  }

  onResponse(message) {
    const entry = this.pending.get(message.id);
    // A reply to something we did not ask, or already gave up on: ignore it.
    if (!entry) return this.noise();
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
    // Exactly one of the two, as the protocol says.
    if (hasResult === hasError) return this.noise();
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (hasError) {
      const error = message.error && typeof message.error === 'object' ? message.error : {};
      entry.reject(new McpError(cleanText(error.message, 300) || 'The server returned an error.', 'server_error', { code: Number.isFinite(error.code) ? error.code : undefined }));
    } else {
      entry.resolve(message.result);
    }
  }

  onServerRequest(message) {
    if (message.method === 'ping') return this.write({ jsonrpc: '2.0', id: message.id, result: {} });
    // We offered no capability that would let a server ask for anything else.
    return this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }

  onNotification(message) {
    if (message.method === 'notifications/tools/list_changed') {
      this.toolsChanged = true;
      if (this.onToolsChanged) { try { this.onToolsChanged(); } catch { /* the caller's problem */ } }
    }
    // Progress, logging and everything else are not used.
  }

  write(message) {
    const child = this.child;
    if (!child || this.exited || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
    try { child.stdin.write(`${JSON.stringify(message)}\n`); return true; } catch { return false; }
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  request(method, params, timeoutMs = this.requestTimeoutMs, { cancellable = true, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (this.exited || this.closing) return reject(new McpError('The server is not running.', 'not_running'));
      if (signal && signal.aborted) return reject(new McpError('Cancelled.', 'cancelled'));
      const id = ++this.seq;
      const settle = (fn) => (value) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const cancel = (why) => { if (cancellable) this.notify('notifications/cancelled', { requestId: id, reason: why }); };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cancel('timeout');
        reject(new McpError(`The server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, 'timeout'));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        cancel('cancelled by the user');
        reject(new McpError('Cancelled.', 'cancelled'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), timer });
      if (!this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })) {
        this.pending.delete(id);
        clearTimeout(timer);
        settle(reject)(new McpError('The server is not accepting messages.', 'not_running'));
      }
    });
  }

  // ---------------------------------------------------------------- tools ---

  /** Every tool the server lists, reduced to what may reach the model. */
  async listTools() {
    const tools = [];
    let dropped = 0;
    let cursor;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (!result || typeof result !== 'object' || !Array.isArray(result.tools)) throw new McpError('The server returned a tool list that is not a list.', 'bad_response');
      for (const raw of result.tools) {
        const tool = normalizeTool(raw);
        // A name listed twice is the server contradicting itself: neither is used.
        if (!tool) { dropped += 1; continue; }
        tools.push(tool);
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    const counts = new Map();
    for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1);
    const unique = tools.filter((tool) => counts.get(tool.name) === 1);
    dropped += tools.length - unique.length;
    if (unique.length > this.maxTools) { dropped += unique.length - this.maxTools; unique.length = this.maxTools; }
    this.toolsChanged = false;
    return { tools: unique, dropped };
  }

  /**
   * Call one tool. Text is all that comes back: images, audio and embedded resources are named and
   * left out, and the text is redacted and cut. The result is data about the outside world.
   */
  async callTool(name, args, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new McpError('That is not a valid tool name.', 'bad_request');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new McpError('Tool arguments must be an object.', 'bad_request');
    let size;
    try { size = Buffer.byteLength(JSON.stringify(args), 'utf8'); } catch { throw new McpError('Tool arguments must be plain JSON.', 'bad_request'); }
    if (size > MAX_ARGUMENT_BYTES) throw new McpError('Tool arguments are too large.', 'bad_request');
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs, { signal });
    if (!result || typeof result !== 'object' || !Array.isArray(result.content)) throw new McpError('The server returned a result that is not content.', 'bad_response');
    const parts = [];
    const omitted = { image: 0, audio: 0, resource: 0, other: 0 };
    for (const item of result.content) {
      if (!item || typeof item !== 'object') { omitted.other += 1; continue; }
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
      else if (item.type === 'image') omitted.image += 1;
      else if (item.type === 'audio') omitted.audio += 1;
      else if (item.type === 'resource' || item.type === 'resource_link') omitted.resource += 1;
      else omitted.other += 1;
    }
    const cut = keepEnds(redactText(parts.join('\n')), MAX_OUTPUT_CHARS);
    const left = Object.entries(omitted).filter(([, n]) => n > 0).map(([kind, n]) => `${n} ${kind}`).join(', ');
    return {
      text: cut.text + (left ? `\n[not shown: ${left}]` : ''),
      isError: result.isError === true,
      truncated: cut.truncated,
      omitted,
    };
  }

  // -------------------------------------------------------------- closing ---

  handleExit(code, signal) {
    if (this.exited) return;
    this.exited = true;
    const reason = this.violationReason || (this.closing ? 'closed' : `The server exited (${signal || `code ${code}`}).`);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new McpError(reason, this.closing ? 'closed' : 'server_exited'));
    }
    this.pending.clear();
    if (this.onExit) { try { this.onExit({ code, signal, closing: this.closing, stderr: redactText(this.stderrTail) }); } catch { /* the caller's problem */ } }
  }

  /** End the server and everything it started; resolves once it is gone. */
  close() {
    if (this.closing && this.closed) return this.closed;
    this.closing = true;
    this.closed = new Promise((resolve) => {
      const child = this.child;
      if (!child || this.exited) {
        this.handleExit(null, null);
        return resolve();
      }
      const done = () => { clearTimeout(hard); resolve(); };
      child.once('exit', done);
      const killGroup = (sig) => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
        catch { try { child.kill(sig); } catch { /* already gone */ } }
      };
      try { child.stdin.end(); } catch { /* closed */ }
      killGroup('SIGTERM');
      const hard = setTimeout(() => { killGroup('SIGKILL'); }, 1500);
      if (hard.unref) hard.unref();
      // The process may have exited between the check and the listener.
      setTimeout(() => { if (this.exited) done(); }, 50).unref?.();
      setTimeout(() => { if (!this.exited) { killGroup('SIGKILL'); this.handleExit(null, 'killed'); done(); } }, 4000).unref?.();
    });
    return this.closed;
  }
}

module.exports = { McpConnection, McpError, PROTOCOL_VERSIONS, MAX_LINE_BYTES };
