'use strict';

const { isAllowed, isBlocked, normalizeApp } = require('./apps');
const { SessionError } = require('./session');
const { ProviderError, SAFE_CODES } = require('./provider');

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
function createComputerActions({ settings, provider, sessions, records }) {
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
      return { status: 'ok', app: clean(app, 80), image: { mime: 'image/png', base64: png.toString('base64'), width: Number(shot.width) || 0, height: Number(shot.height) || 0 }, stepsLeft, outputIsData: true };
    } catch (error) {
      if (error instanceof SessionError) return refuse(error.code, error.message);
      throw error;
    }
  }

  return { state, screenshot };
}

module.exports = { createComputerActions, MAX_IMAGE_BYTES };
