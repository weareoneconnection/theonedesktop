'use strict';

const crypto = require('node:crypto');

/**
 * What an action on an application's window may be, decided before anything is sent. Pure: no system calls.
 *
 *   click  at a point of the last picture of the window (its own pixels), once or twice
 *   type   a short plain text into the window
 *   key    one of a few plain keys (no modifiers)
 *
 * Every action is approved on its own by the person, so these rules are the floor, not the only check.
 */

class ActionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const MAX_TEXT = 500;
// Plain keys only. Nothing with Cmd/Ctrl/Alt: no quitting, closing, deleting a file or opening a menu by shortcut.
const KEYS = Object.freeze(['return', 'tab', 'escape', 'space', 'delete', 'up', 'down', 'left', 'right']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

// Credentials and secrets: typing one is never asked of a model that can only see a window.
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|passphrase|secret|token|api[_ -]?key)\s*[:=]\s*\S{4,}/i,
  /(?:密码|口令|密钥)\s*[:：=]\s*\S{2,}/,
];

/** A run of 13–19 digits (spaces and dashes allowed) that passes the Luhn check: a card number. */
function looksLikeCardNumber(text) {
  for (const match of String(text).matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      let value = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { value *= 2; if (value > 9) value -= 9; }
      sum += value;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

function looksLikeSecret(text) {
  const value = String(text ?? '');
  return SECRET_PATTERNS.some((pattern) => pattern.test(value)) || looksLikeCardNumber(value);
}

// A window that says it is for signing in, paying or entering a password: the person does that themselves.
const SENSITIVE_TITLE = /\b(?:password|passcode|sign[ -]?in|log[ -]?in|login|checkout|payment|pay now|credit card|bank|2fa|two-factor|verification code)\b|登录|登入|密码|口令|支付|付款|结账|银行|验证码/i;
function sensitiveTitle(title) {
  return SENSITIVE_TITLE.test(String(title || ''));
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** The action as written, checked for shape and cleaned. */
function normalizeAction(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const kind = typeof input.kind === 'string' ? input.kind : '';
  if (kind === 'click') {
    const { x, y, imageWidth, imageHeight } = input;
    if (![x, y, imageWidth, imageHeight].every(finite) || imageWidth < 50 || imageHeight < 50 || imageWidth > 20000 || imageHeight > 20000) throw new ActionError('bad_action', 'A click needs x, y and the size of the picture they refer to.');
    if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) throw new ActionError('outside', 'That point is outside the window picture.');
    return { kind, x: Math.round(x), y: Math.round(y), imageWidth: Math.round(imageWidth), imageHeight: Math.round(imageHeight), double: input.double === true };
  }
  if (kind === 'type') {
    const text = typeof input.text === 'string' ? input.text : '';
    if (!text) throw new ActionError('bad_action', 'There is no text to type.');
    if (text.length > MAX_TEXT) throw new ActionError('too_long', `A text to type has at most ${MAX_TEXT} characters.`);
    if (CONTROL.test(text)) throw new ActionError('bad_action', 'Typed text is plain text: no line breaks or control characters (use the Return key to submit).');
    if (looksLikeSecret(text)) throw new ActionError('secret', 'That looks like a password, key or card number. Ask the person to type it themselves.');
    return { kind, text };
  }
  if (kind === 'key') {
    const name = typeof input.key === 'string' ? input.key.toLowerCase() : '';
    if (!KEYS.includes(name)) throw new ActionError('bad_action', `Only these keys can be pressed: ${KEYS.join(', ')}.`);
    return { kind, key: name };
  }
  throw new ActionError('bad_action', 'An action is a click, some text to type or one key.');
}

/**
 * Where a click lands, in points on the screen, from a point of the picture. The picture must be the shape of the
 * window (a stale or wrong size is refused), and the point must fall inside it.
 */
function mapClick(action, window) {
  const { x: wx, y: wy, w, h } = window;
  if (![wx, wy, w, h].every(finite) || w <= 0 || h <= 0) throw new ActionError('moved', 'The window’s position is not known.');
  const pictureAspect = action.imageWidth / action.imageHeight;
  const windowAspect = w / h;
  if (Math.abs(pictureAspect - windowAspect) / windowAspect > 0.03) throw new ActionError('stale', 'The picture is not the shape of the window any more. Look again first.');
  const point = { x: wx + (action.x / action.imageWidth) * w, y: wy + (action.y / action.imageHeight) * h };
  if (point.x < wx || point.y < wy || point.x > wx + w || point.y > wy + h) throw new ActionError('outside', 'That point is outside the window.');
  return point;
}

/** The digest an approval is for: this action, on this window of this application, as the window is right now. */
function actionDigest({ app, window, action }) {
  const body = JSON.stringify({ app: String(app || '').toLowerCase(), window: { id: window.id, x: window.x, y: window.y, w: window.w, h: window.h }, action });
  return crypto.createHash('sha256').update(body).digest('hex');
}

/** One line for the person and the record: what the action is, without a typed text's content in the log form. */
function describeAction(action, { forLog = false } = {}) {
  if (action.kind === 'click') return `${action.double ? 'double-click' : 'click'} (${action.x}, ${action.y}) of ${action.imageWidth}×${action.imageHeight}`;
  if (action.kind === 'type') return forLog ? `type ${action.text.length} characters` : `type “${action.text}”`;
  return `press ${action.key}`;
}

module.exports = { ActionError, MAX_TEXT, KEYS, looksLikeSecret, looksLikeCardNumber, sensitiveTitle, normalizeAction, mapClick, actionDigest, describeAction };
