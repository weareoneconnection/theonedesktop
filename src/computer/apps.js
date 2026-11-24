'use strict';

/**
 * Which applications TheOne may look at. The person adds them one by one; there is no "all". Some
 * can never be added, whatever is asked: the ones that hold passwords, keys and the system's own
 * privacy settings. Matching is on the application's name, ignoring case and a trailing ".app".
 */

// A name containing one of these is blocked ("1Password 7" contains "1password").
const DEFAULT_BLOCKED = Object.freeze([
  'keychain access', 'system settings', 'system preferences', 'passwords',
  '1password', 'bitwarden', 'lastpass', 'dashlane', 'keepass', 'enpass', 'nordpass', 'roboform', 'proton pass', 'authy',
  'ledger live', 'trezor', 'metamask', 'exodus',
]);
const MAX_APPS = 20;
const MAX_NAME = 80;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f/\\]/;

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The name as compared: trimmed, lower-cased, no ".app", single spaces. */
function normalizeApp(name) {
  return String(name ?? '').replace(/\.app$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isBlocked(name) {
  const normal = normalizeApp(name);
  return DEFAULT_BLOCKED.some((blocked) => normal.includes(blocked));
}

/** A name that may be stored, or an AppError saying why not. */
function validateApp(name) {
  if (typeof name !== 'string') throw new AppError('bad_name', 'An application is named by its name.');
  // Control characters are refused as written, before whitespace is tidied: a newline is not a space.
  if (BAD_CHARS.test(name)) throw new AppError('bad_name', 'That is not a usable application name.');
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > MAX_NAME) throw new AppError('bad_name', 'That is not a usable application name.');
  if (isBlocked(clean)) throw new AppError('blocked', 'TheOne cannot look at that application: it holds passwords or system privacy settings.');
  return clean.replace(/\.app$/i, '');
}

/** Whether `name` is one of the apps the person added (and still not blocked, in case the list changed). */
function isAllowed(apps, name) {
  const normal = normalizeApp(name);
  if (!normal || isBlocked(name)) return false;
  return (Array.isArray(apps) ? apps : []).some((app) => normalizeApp(app) === normal);
}

module.exports = { AppError, DEFAULT_BLOCKED, MAX_APPS, normalizeApp, isBlocked, validateApp, isAllowed };
