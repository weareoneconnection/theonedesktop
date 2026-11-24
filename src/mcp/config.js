'use strict';

/**
 * An MCP server is a program the person names. Adding one is running code as them, so what is
 * accepted is narrow, and what the program is given is narrower still: the environment it
 * starts with is a short list plus the variables the person declared for it, never this app's.
 */

const path = require('node:path');
const { SERVER_NAME } = require('./sanitize');

const MAX_SERVERS = 12;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
// Variables that change what other programs run, or where they read their settings from.
const FORBIDDEN_ENV = /^(PATH|HOME|SHELL|IFS|PS4|BASH_ENV|ENV|LD_[A-Z_]+|DYLD_[A-Z_]+|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|CLASSPATH|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_EXTERNAL_DIFF|GIT_PAGER|GIT_CONFIG[A-Z_]*|SSH_ASKPASS|EDITOR|VISUAL|PAGER|ELECTRON_[A-Z_]+|npm_config_[a-z_]+|NPM_CONFIG_[A-Z_]+)$/;
const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];

function fail(message) { throw new Error(message); }

/**
 * A server definition as the person gave it, or an error saying what is wrong.
 * `env` maps names to values; the values are returned separately so they can be stored encrypted.
 */
function validateServerDefinition(input, existing = []) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : fail('A server needs a definition.');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!SERVER_NAME.test(name)) fail('The name must be 1–32 lowercase letters, digits, - or _, starting with a letter or digit.');
  if (existing.some((server) => server.name === name)) fail('A server with that name already exists.');
  if (existing.length >= MAX_SERVERS) fail(`At most ${MAX_SERVERS} servers can be added.`);
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  if (!command || command.length > 500 || /[\0\r\n]/.test(command)) fail('The command must be one line, at most 500 characters.');
  // No shell: a command line is a program and its arguments, never text a shell would interpret.
  if (/\s/.test(command)) fail('The command is the program only; put its arguments in the argument list.');
  const args = Array.isArray(value.args) ? value.args : value.args === undefined ? [] : fail('Arguments must be a list.');
  if (args.length > 50) fail('At most 50 arguments.');
  const cleanArgs = args.map((arg) => {
    if (typeof arg !== 'string' || arg.length > 1000 || /[\0\r\n]/.test(arg)) fail('Each argument must be one line of text, at most 1000 characters.');
    return arg;
  });
  const envInput = value.env && typeof value.env === 'object' && !Array.isArray(value.env) ? value.env : value.env === undefined ? {} : fail('Environment must be a set of names and values.');
  const envNames = Object.keys(envInput);
  if (envNames.length > 20) fail('At most 20 environment variables.');
  for (const key of envNames) {
    if (!ENV_NAME.test(key)) fail(`${key.slice(0, 40)} is not a valid variable name (capital letters, digits and _).`);
    if (FORBIDDEN_ENV.test(key)) fail(`${key} cannot be set for a server: it changes what programs run or where they read their settings.`);
    if (typeof envInput[key] !== 'string' || envInput[key].length > 4000 || /\0/.test(envInput[key])) fail(`The value of ${key} must be text of at most 4000 characters.`);
  }
  return { name, command, args: cleanArgs, envNames, envValues: Object.fromEntries(envNames.map((key) => [key, envInput[key]])) };
}

/** The environment a server starts with: a short allowlist from this process, the PATH to use, and what was declared. */
function buildChildEnv({ declared = {}, pathValue, source = process.env, platform = process.platform } = {}) {
  const env = {};
  for (const key of BASE_ENV) if (typeof source[key] === 'string' && source[key]) env[key] = source[key];
  if (pathValue) env.PATH = pathValue;
  if (platform === 'win32') for (const key of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) if (source[key]) env[key] = source[key];
  for (const [key, val] of Object.entries(declared)) if (ENV_NAME.test(key) && !FORBIDDEN_ENV.test(key)) env[key] = String(val);
  return env;
}

/** What the confirmation dialog shows: the program, its arguments, and the names (never the values) of its variables. */
function describeCommandLine(def) {
  const quote = (word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word));
  const line = [def.command, ...def.args].map(quote).join(' ');
  return { line, env: [...def.envNames] };
}

/** A server's own folder inside the app's data folder: nothing of the person's is its working directory. */
function serverWorkingDirectory(dataDir, name) {
  if (!SERVER_NAME.test(name)) fail('Invalid server name.');
  return path.join(dataDir, 'mcp', name);
}

module.exports = { validateServerDefinition, buildChildEnv, describeCommandLine, serverWorkingDirectory, MAX_SERVERS, FORBIDDEN_ENV, ENV_NAME };
