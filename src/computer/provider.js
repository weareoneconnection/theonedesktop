'use strict';

/**
 * What can actually look at an application's window. This is a seam: the rest of computer use is
 * written and tested against it, and a real provider must be verified on a real Mac before it is
 * plugged in. It must return only the picture of the named app's own window (never the whole
 * screen, and nothing that covers it), and throw if that window is hidden or not found.
 *
 *   supported: boolean
 *   captureWindow(app) -> Promise<{ png: Buffer, width: number, height: number }>
 *   appState(app)      -> Promise<{ running: boolean, frontmost: boolean, windows: string[] }>
 */
const unsupportedProvider = Object.freeze({
  supported: false,
  reason: 'This version of TheOne Desktop cannot capture a single application window yet.',
  async captureWindow() { throw new Error('unsupported'); },
  async appState() { throw new Error('unsupported'); },
});

module.exports = { unsupportedProvider };
