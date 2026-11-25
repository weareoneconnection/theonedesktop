'use strict';

const fs = require('node:fs');

/**
 * What TheOne has done on this computer, from the records the desktop app and the runtime keep: terminal
 * commands, MCP tool uses, and looks at an application's window. Read only the end of each file, shown as
 * short plain text (never a whole command output, picture or argument list), newest first.
 */

const TAIL_BYTES = 256 * 1024;
const MAX_ITEMS = 100;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// Anything that looks like a credential is hidden, whatever the writer already did.
const SECRET = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{12,}|\bAIza[0-9A-Za-z_-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g;

const clean = (value, max) => String(value ?? '').replace(CONTROL, ' ').replace(SECRET, '[hidden]').replace(/\s+/g, ' ').trim().slice(0, max);

/** The last `bytes` of a file as complete lines ([] if it is missing or unreadable). */
function tailLines(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    // A read that started mid-file starts mid-line: that first piece is not a record.
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to close */ } }
  }
}

function parse(lines) {
  const out = [];
  for (const line of lines) {
    try { const entry = JSON.parse(line); if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.push(entry); } catch { /* a torn line is skipped */ }
  }
  return out;
}

const when = (value) => {
  const time = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : 0;
};

function fromTerminal(entry) {
  const refused = String(entry.decision || '').toLowerCase().includes('den') || String(entry.tier || '').toLowerCase() === 'deny';
  const ran = Number.isFinite(Number(entry.exitCode));
  return {
    at: when(entry.at), source: 'terminal',
    title: clean(entry.command, 300),
    detail: clean(entry.workspace || entry.cwd, 200),
    outcome: refused ? 'refused' : ran ? (Number(entry.exitCode) === 0 ? 'ok' : 'failed') : 'asked',
    ms: Number.isFinite(Number(entry.elapsedMs)) ? Number(entry.elapsedMs) : undefined,
  };
}

function fromMcp(entry) {
  const outcome = String(entry.outcome || '').toLowerCase();
  return {
    at: when(entry.at), source: 'mcp',
    title: `${clean(entry.server, 40)} › ${clean(entry.tool, 80)}`,
    detail: clean(entry.argsPreview, 200),
    outcome: outcome === 'ok' ? 'ok' : outcome === 'tool_error' || outcome === 'error' ? 'failed' : outcome ? 'refused' : 'ok',
    ms: Number.isFinite(Number(entry.ms)) ? Number(entry.ms) : undefined,
  };
}

function fromComputer(entry) {
  return { at: when(entry.at), source: 'computer', title: `${clean(entry.kind, 30)} · ${clean(entry.app, 80)}`, detail: '', outcome: 'ok' };
}

/** The newest activity across the three records. */
function readActivity({ terminalAudit, mcpAudit, computerLog, limit = 50 } = {}) {
  const all = [
    ...(terminalAudit ? parse(tailLines(terminalAudit)).map(fromTerminal) : []),
    ...(mcpAudit ? parse(tailLines(mcpAudit)).map(fromMcp) : []),
    ...(computerLog ? parse(tailLines(computerLog)).map(fromComputer) : []),
  ].filter((item) => item.at > 0 && item.title);
  all.sort((a, b) => b.at - a.at);
  return all.slice(0, Math.max(1, Math.min(MAX_ITEMS, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 50)));
}

module.exports = { readActivity, tailLines, TAIL_BYTES, MAX_ITEMS };
