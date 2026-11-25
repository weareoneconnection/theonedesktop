'use strict';

const { isAllowed, isBlocked, normalizeApp } = require('./apps');
const { SessionError } = require('./session');
const { ProviderError, SAFE_CODES } = require('./provider');
const crypto = require('node:crypto');
const { ActionError, normalizeAction, mapClick, actionDigest, describeAction, sensitiveTitle } = require('./input-rules');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const clean = (value, max) => String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const refuse = (code, message) => ({ status: 'error', code, message, outputIsData: true });

/**
 * The two things the chat can ask of the screen: how an allowed app looks (state) and a picture of its
 * window (screenshot). Both stay inside the apps the person added; a refusal is an answer for the model
 * to read, never an exception. The first picture of each app in a conversation needs the person's
 * approval, which the chat passes on only after they gave it.
 */
const LOOK_FRESH_MS = 120_000;
const SETTLE_MS = 450;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameWindow = (a, b) => a && b && a.id === b.id && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function createComputerActions({ settings, provider, sessions, records, settle = wait, now = () => Date.now() }) {
  // What each conversation last saw of each application's window: where it stood, and a fingerprint of the picture.
  const lastShots = new Map();
  const shotKey = (sessionId, app) => `${String(sessionId)}\u0000${normalizeApp(app)}`;
  function gate(app) {
    const config = settings();
    if (!config.enabled) return refuse('off', 'Computer use is turned off. Ask the person to turn it on in settings.');
    if (isBlocked(app)) return refuse('blocked', 'That application can never be looked at.');
    if (!isAllowed(config.apps, app)) return refuse('app_not_allowed', 'The person has not allowed TheOne to look at that application.');
    if (!provider.supported) return refuse('capture_unsupported', provider.reason || 'This computer cannot capture an application window yet.');
    return null;
  }

  // A provider says why in a few words that are safe to show; anything else is a generic failure.
  function fromProvider(error, code, message) {
    if (error instanceof ProviderError && SAFE_CODES.has(error.code)) return refuse(error.code, clean(error.message, 300));
    return refuse(code, message);
  }

  async function state({ app }) {
    const refused = gate(app);
    if (refused) return refused;
    try {
      const found = await provider.appState(app);
      return { status: 'ok', app: clean(app, 80), running: found.running === true, frontmost: found.frontmost === true, windows: (Array.isArray(found.windows) ? found.windows : []).slice(0, 10).map((title) => clean(title, 100)), outputIsData: true };
    } catch (error) {
      return fromProvider(error, 'state_failed', 'Could not read that application\'s state.');
    }
  }

  async function screenshot({ app, sessionId, approved }) {
    const refused = gate(app);
    if (refused) return refused;
    const key = normalizeApp(app);
    try {
      if (!sessions.isApproved(sessionId, key)) {
        // Only a boolean true is an approval; anything else asks.
        if (approved !== true) return { status: 'needs_approval', app: clean(app, 80) };
        sessions.approve(sessionId, key);
      }
      const { stepsLeft } = sessions.step(sessionId);
      let shot;
      try { shot = await provider.captureWindow(app); } catch (error) { return fromProvider(error, 'capture_failed', 'Could not capture that application\'s window. It may be hidden or closed.'); }
      const png = shot && Buffer.isBuffer(shot.png) ? shot.png : null;
      if (!png || !png.length || png.length > MAX_IMAGE_BYTES) return refuse('capture_failed', 'The picture was empty or too large.');
      records.add({ session: sessionId, app, kind: 'screenshot', image: png });
      if (shot.window) lastShots.set(shotKey(sessionId, app), { window: shot.window, at: now(), hash: crypto.createHash('sha1').update(png).digest('hex') });
      return { status: 'ok', app: clean(app, 80), image: { mime: 'image/png', base64: png.toString('base64'), width: Number(shot.width) || 0, height: Number(shot.height) || 0 }, stepsLeft, outputIsData: true };
    } catch (error) {
      if (error instanceof SessionError) return refuse(error.code, error.message);
      throw error;
    }
  }

  /**
   * One click, some typing or one key, on an application's window, each approved by the person on its own. The
   * approval is the digest of this action on this window as it stands right now: a window that moved, or a different
   * action, is a different digest and is refused. Events go to that window's process only, and only when the system
   * lets this app send them (checked first: it drops them without a word otherwise). Afterwards a new picture is taken, and
   * whether it differs from the one before is reported, so a click that did nothing is not mistaken for one that worked.
   */
  async function act(input) {
    const { app, sessionId, approval } = input;
    const refused = gate(app);
    if (refused) return refused;
    if (settings().allowInput !== true) return refuse('input_off', 'Clicking and typing is off. Ask the person to turn it on in settings.');
    if (!provider.input || provider.input.supported !== true || typeof provider.findWindow !== 'function') return refuse('input_unsupported', 'Clicking and typing is not available on this system yet.');
    if (!(await provider.input.trusted())) return refuse('permission', 'TheOne is not allowed to control the computer yet. The person can allow it in System Settings → Privacy & Security → Accessibility.');
    let action;
    try { action = normalizeAction(input); } catch (error) { if (error instanceof ActionError) return refuse(error.code, error.message); throw error; }
    try {
      if (!sessions.isApproved(sessionId, normalizeApp(app))) return refuse('not_looked', 'Look at the application first (and have the person approve it) before acting on it.');
      const last = lastShots.get(shotKey(sessionId, app));
      if (!last || now() - last.at > LOOK_FRESH_MS) return refuse('stale', 'Look at the window again first: a click refers to the latest picture of it.');
      let current;
      try { current = await provider.findWindow(app); } catch (error) { return fromProvider(error, 'state_failed', 'Could not find that window.'); }
      if (!current) return refuse('not_running', 'That application has no window on screen.');
      if (!sameWindow(current, last.window)) return refuse('moved', 'The window moved or changed size since the last picture. Look again first.');
      if (sensitiveTitle(current.title)) return refuse('sensitive_window', 'This window looks like a sign-in, payment or password screen. The person does that themselves.');
      const point = action.kind === 'click' ? mapClick(action, current) : null;
      const digest = actionDigest({ app, window: current, action });
      if (!approval || typeof approval.digest !== 'string') {
        return { status: 'needs_approval', app: clean(app, 80), digest, action: describeAction(action), outputIsData: true };
      }
      if (approval.digest !== digest) return refuse('changed', 'This is not what was approved: the action or the window changed since the card. Look again.');
      const { stepsLeft } = sessions.step(sessionId);
      try {
        if (action.kind === 'click') await provider.input.click(current, point, { double: action.double });
        else if (action.kind === 'type') await provider.input.type(current, action.text);
        else await provider.input.key(current, action.key);
      } catch (error) {
        return fromProvider(error, 'act_failed', 'The action could not be carried out.');
      }
      // A typed text is never written to the record, only how long it was.
      records.add({ session: sessionId, app, kind: action.kind, note: describeAction(action, { forLog: true }) });
      await settle(SETTLE_MS);
      let after = null;
      try { after = await provider.captureWindow(app); } catch { /* the action was done; the new picture is a bonus */ }
      if (!after || !Buffer.isBuffer(after.png) || !after.png.length || after.png.length > MAX_IMAGE_BYTES) {
        return { status: 'ok', app: clean(app, 80), acted: describeAction(action, { forLog: true }), changed: null, stepsLeft, note: 'It was done, but a new picture could not be taken.', outputIsData: true };
      }
      const hash = crypto.createHash('sha1').update(after.png).digest('hex');
      const changed = hash !== last.hash;
      if (after.window) lastShots.set(shotKey(sessionId, app), { window: after.window, at: now(), hash });
      records.add({ session: sessionId, app, kind: 'screenshot', image: after.png });
      return { status: 'ok', app: clean(app, 80), acted: describeAction(action, { forLog: true }), changed, image: { mime: 'image/png', base64: after.png.toString('base64'), width: after.width, height: after.height }, stepsLeft, outputIsData: true };
    } catch (error) {
      if (error instanceof SessionError) return refuse(error.code, error.message);
      if (error instanceof ActionError) return refuse(error.code, error.message);
      throw error;
    }
  }

  return { state, screenshot, act };
}

module.exports = { createComputerActions, MAX_IMAGE_BYTES };
