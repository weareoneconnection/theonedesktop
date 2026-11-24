'use strict';

/**
 * What comes back from an MCP server is the server's word, not ours: tool names, descriptions
 * and schemas go into a model's context, and results go back to it. Everything here makes that
 * text safe to carry: no control or invisible characters, bounded sizes, secrets masked, and a
 * digest that notices when a server changes what it told the person at approval time.
 */

const crypto = require('node:crypto');

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_DESCRIPTION = 1000;
const MAX_SCHEMA_BYTES = 20_000;
const MAX_OUTPUT_CHARS = 30_000;

/** One line of plain text: no control or invisible characters, single spaces, at most `max` long. */
function cleanText(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The same value with object keys in a fixed order, so equal things serialise equally. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A tool as the server described it, reduced to what may reach the model; null when it cannot be used.
 * `readOnlyHint` and the other annotations are the server's own claims and are not carried at all.
 */
function normalizeTool(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!TOOL_NAME.test(name)) return null;
  let schema = raw.inputSchema === undefined ? { type: 'object', properties: {} } : raw.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || (schema.type !== undefined && schema.type !== 'object')) return null;
  let size;
  try { size = Buffer.byteLength(JSON.stringify(schema), 'utf8'); } catch { return null; }
  if (size > MAX_SCHEMA_BYTES) return null;
  schema = JSON.parse(JSON.stringify(schema));
  // Descriptions inside the schema are text the model reads too.
  stripSchemaText(schema, 0);
  return { name, description: cleanText(raw.description, MAX_DESCRIPTION), inputSchema: schema };
}

function stripSchemaText(node, depth) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if ((key === 'description' || key === 'title') && typeof value === 'string') node[key] = cleanText(value, 300);
    else if (value && typeof value === 'object') stripSchemaText(value, depth + 1);
  }
}

/** Identifies exactly the tools (names, descriptions, schemas) a person was shown. */
function toolListDigest(tools) {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return crypto.createHash('sha256').update(canonical(sorted.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })))).digest('hex');
}

/** The name the model sees: mcp__server__tool, at most 64 characters, or null if it cannot fit. */
function exposedToolName(server, tool) {
  if (!SERVER_NAME.test(String(server)) || !TOOL_NAME.test(String(tool))) return null;
  const name = `mcp__${server}__${tool}`;
  return name.length <= 64 ? name : null;
}

function redactText(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:x-api-key|api[_-]?key|token|password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)(["']?)([^\s"',;&}]{4,})/gi, '$1$2[REDACTED]')
    .replace(/\b(?:sk-ant-|sk-proj-|sk-live-|ghp_|gho_|github_pat_|xox[abp]-)[A-Za-z0-9._-]+\b/g, '[REDACTED_CREDENTIAL]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@');
}

/** Long output keeps its start and its end, where results and errors usually are. */
function keepEnds(text, limit = MAX_OUTPUT_CHARS) {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit * 0.3);
  const tail = limit - head;
  return { text: `${text.slice(0, head)}\n… [${text.length - limit} characters omitted from the middle; the end follows]\n${text.slice(-tail)}`, truncated: true };
}

module.exports = { cleanText, canonical, normalizeTool, toolListDigest, exposedToolName, redactText, keepEnds, TOOL_NAME, SERVER_NAME, MAX_OUTPUT_CHARS, MAX_DESCRIPTION, MAX_SCHEMA_BYTES };
