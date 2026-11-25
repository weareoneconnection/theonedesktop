'use strict';

/**
 * What can actually look at an application's window. The rest of computer use is written and tested
 * against this seam. A provider must return only the picture of the named app's own window (never the whole
 * screen, and nothing that covers it) and throw a ProviderError if that window is hidden or not found.
 *
 *   supported: boolean
 *   captureWindow(app) -> Promise<{ png: Buffer, width: number, height: number }>
 *   appState(app)      -> Promise<{ running: boolean, frontmost: boolean, windows: string[] }>
 */

class ProviderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The codes whose message is safe, and useful, to show the model and the person. */
const SAFE_CODES = new Set(['not_running', 'not_visible', 'permission', 'too_large', 'unsupported']);

const unsupportedProvider = Object.freeze({
  supported: false,
  reason: 'TheOne Desktop cannot capture a single application window on this system yet.',
  async captureWindow() { throw new ProviderError('unsupported', 'unsupported'); },
  async appState() { throw new ProviderError('unsupported', 'unsupported'); },
});

/** The width and height of a PNG from its header, or null if it is not one. */
function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 20000 && height <= 20000 ? { width, height } : null;
}

/** The provider for this system. `deps` carries what only the app has (child processes, Electron's capturer). */
function createProvider(platform, deps = {}) {
  if (platform === 'darwin') return require('./mac-provider').createMacProvider({ platform, ...deps });
  if (platform === 'win32') return require('./win-provider').createWinProvider({ platform, ...deps });
  return unsupportedProvider;
}

module.exports = { ProviderError, SAFE_CODES, unsupportedProvider, pngSize, createProvider };
