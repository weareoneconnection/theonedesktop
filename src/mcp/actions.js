'use strict';

/**
 * The two things the chat can ask of the MCP servers: which tools it may use, and to use one.
 * Both read only what the person approved — the tool definitions stored when they chose them,
 * not whatever a server says today — and a call goes through the manager, which refuses it
 * unless the server is on, the tool was turned on and the server's tools are still the approved ones.
 */

const { McpError } = require('./client');
const { exposedToolName, cleanText } = require('./sanitize');

const MAX_EXPOSED_TOOLS = 40;

/**
 * Every tool the person turned on, as the model should see it. A server that is off, failed or whose
 * tools changed since approval contributes none (and is listed with why, so the chat can say so).
 */
function approvedToolList(servers, statusOf) {
  const tools = [];
  const summary = [];
  for (const server of servers) {
    const status = statusOf(server.id);
    const usable = server.enabled === true && Boolean(server.approvedDigest) && !status.failed && !status.changed;
    const approved = Array.isArray(server.approvedTools) ? server.approvedTools : [];
    let count = 0;
    if (usable) {
      for (const tool of approved) {
        if (tools.length >= MAX_EXPOSED_TOOLS) break;
        // Only a tool the person turned on, under a name that cannot collide with a built-in one.
        if (!(server.enabledTools || []).includes(tool.name)) continue;
        const exposed = exposedToolName(server.name, tool.name);
        if (!exposed) continue;
        tools.push({ server: server.id, serverName: server.name, tool: tool.name, name: exposed, description: tool.description, inputSchema: tool.inputSchema });
        count += 1;
      }
    }
    summary.push({
      server: server.id, name: server.name, tools: count,
      state: !server.enabled ? 'off' : status.failed ? 'failed' : status.changed ? 'changed' : !server.approvedDigest ? 'not_approved' : 'ready',
    });
  }
  return { tools, servers: summary };
}

/** Use one approved tool. A refusal or a failure is an answer for the model to read, not an exception. */
async function callApprovedTool(manager, { server, tool, arguments: args }, { by = 'chat', signal } = {}) {
  try {
    const result = await manager.call(server, tool, args, { by, signal });
    return { status: result.isError ? 'tool_error' : 'ok', text: result.text, truncated: result.truncated, omitted: result.omitted, outputIsData: true };
  } catch (error) {
    if (error instanceof McpError) return { status: 'error', code: error.code, message: cleanText(error.message, 300), outputIsData: true };
    throw error;
  }
}

module.exports = { approvedToolList, callApprovedTool, MAX_EXPOSED_TOOLS };
