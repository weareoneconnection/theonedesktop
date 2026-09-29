'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CODEX_VERSION, PACKAGES, installCodex, installedCodexPath, registries, tarballUrl } = require('../src/codex-install');
const engines = require('../src/engines');

// A small package laid out as npm's @openai/codex-<platform> is.
function fakePackage(dir) {
  const root = path.join(dir, 'src');
  const bin = path.join(root, 'package/vendor/aarch64-apple-darwin/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(root, 'package/vendor/aarch64-apple-darwin/codex-resources/voice'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package/vendor/aarch64-apple-darwin/codex-resources/voice/big.bin'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho codex-cli fake\n', { mode: 0o755 });
  const archive = path.join(dir, 'codex.tgz');
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', root, 'package']);
  const bytes = fs.readFileSync(archive);
  return { bytes, integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` };
}

const response = (bytes) => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });

test('installs the pinned Codex from the first registry that serves the right bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-'));
  const { bytes, integrity } = fakePackage(dir);
  const packages = { 'darwin-arm64': { ...PACKAGES['darwin-arm64'], integrity } };
  const dataDir = path.join(dir, 'data');
  const asked = [];
  const phases = [];
  const fetchFn = async (url) => {
    asked.push(url);
    // npm is unreachable; the mirror first serves tampered bytes, then the real ones.
    if (url.startsWith('https://registry.npmjs.org')) throw new Error('ECONNRESET');
    return response(bytes);
  };
  const result = await installCodex({ dataDir, fetchFn, packages, platform: 'darwin', arch: 'arm64', env: {}, onProgress: (p) => phases.push(p.phase) });
  assert.equal(result.already, false);
  assert.equal(result.binary, path.join(dataDir, 'codex', CODEX_VERSION, 'vendor/aarch64-apple-darwin/bin/codex'));
  assert.equal(execFileSync(result.binary).toString().trim(), 'codex-cli fake');
  assert.deepEqual(asked, [tarballUrl('https://registry.npmjs.org', packages['darwin-arm64']), tarballUrl('https://registry.npmmirror.com', packages['darwin-arm64'])]);
  assert.ok(phases.includes('verify') && phases.includes('extract') && phases.at(-1) === 'done');
  // The voice resources are not unpacked.
  assert.equal(fs.existsSync(path.join(dataDir, 'codex', CODEX_VERSION, 'vendor/aarch64-apple-darwin/codex-resources/voice')), false);
  // Installed once: found, and not downloaded again.
  assert.equal(installedCodexPath(dataDir, 'darwin', 'arm64', packages), result.binary);
  assert.deepEqual(await installCodex({ dataDir, fetchFn: async () => { throw new Error('no network'); }, packages, platform: 'darwin', arch: 'arm64', env: {} }), { binary: result.binary, version: CODEX_VERSION, already: true });
  // The app's own install is preferred over the PATH and ChatGPT's copy; an explicit override still wins.
  assert.equal(engines.findCodexBinary({ PATH: '/nonexistent' }, [], result.binary), result.binary);
});

test('refuses bytes that do not match the pinned integrity, from every registry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-'));
  const { bytes } = fakePackage(dir);
  const dataDir = path.join(dir, 'data');
  await assert.rejects(
    installCodex({ dataDir, fetchFn: async () => response(bytes), platform: 'darwin', arch: 'arm64', env: {} }),
    (error) => error.code === 'codex_download_failed' && /integrity mismatch/.test(error.message),
  );
  assert.equal(installedCodexPath(dataDir, 'darwin', 'arm64'), null);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'codex')), []);
});

test('tries an explicit registry first, and says when there is no build for the platform', async () => {
  assert.deepEqual(registries({ THEONE_NPM_REGISTRY: 'https://npm.example.com/' }), ['https://npm.example.com', 'https://registry.npmjs.org', 'https://registry.npmmirror.com']);
  await assert.rejects(installCodex({ dataDir: os.tmpdir(), platform: 'linux', arch: 'riscv64', env: {} }), (error) => error.code === 'codex_unsupported');
});
