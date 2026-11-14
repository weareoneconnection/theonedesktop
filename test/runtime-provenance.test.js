'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalRuntime } = require('../src/runtime');
const { digestRuntimeTree, loadRuntimeProvenance, PROVENANCE_SCHEMA } = require('../src/runtime-provenance');

test('runtime provenance is bound to the exact packaged OneClaw entry', (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const runtimeRoot = path.join(resourcesPath, 'oneclaw');
  const entry = path.join(runtimeRoot, 'dist', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'module.exports = true;');
  const receipt = {
    schemaVersion: PROVENANCE_SCHEMA,
    oneClawVersion: '0.4.0',
    oneClawCommit: 'a'.repeat(40),
    sourceDirty: false,
    distDigest: digestRuntimeTree(path.dirname(entry)),
    unreviewed: 'must not cross the bridge',
  };
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), `${JSON.stringify(receipt)}\n`);

  assert.deepEqual(loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath }), {
    schemaVersion: PROVENANCE_SCHEMA,
    oneClawVersion: receipt.oneClawVersion,
    oneClawCommit: receipt.oneClawCommit,
    sourceDirty: false,
    distDigest: receipt.distDigest,
    integrity: 'verified',
    actualDistDigest: receipt.distDigest,
    integrityReason: null,
  });
  assert.equal(loadRuntimeProvenance({ entry: path.join(resourcesPath, 'custom.js'), isPackaged: true, resourcesPath }), null);
  assert.equal(loadRuntimeProvenance({ entry, isPackaged: false, resourcesPath }), null);

  const provenance = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  const runtime = new LocalRuntime({ entry, dataDir: resourcesPath, provenance });
  assert.equal(runtime.provenance.integrity, 'verified');
});

test('runtime provenance detects changed bytes and the runtime refuses them', async (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-mismatch-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const runtimeRoot = path.join(resourcesPath, 'oneclaw');
  const entry = path.join(runtimeRoot, 'dist', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'original');
  const receipt = {
    schemaVersion: PROVENANCE_SCHEMA,
    oneClawVersion: '0.4.0',
    oneClawCommit: 'a'.repeat(40),
    sourceDirty: false,
    distDigest: digestRuntimeTree(path.dirname(entry)),
  };
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), `${JSON.stringify(receipt)}\n`);
  fs.writeFileSync(entry, 'tampered');

  const provenance = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  assert.equal(provenance.integrity, 'mismatch');
  assert.notEqual(provenance.actualDistDigest, receipt.distDigest);
  const runtime = new LocalRuntime({ entry, dataDir: resourcesPath, provenance });
  assert.deepEqual(await runtime.start('', '', false), {
    status: 'error', error: 'Packaged OneClaw code failed its digest check.',
  });
});

test('the default packaged runtime fails closed when its receipt is missing or incomplete', async (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-legacy-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const runtimeRoot = path.join(resourcesPath, 'oneclaw');
  const entry = path.join(runtimeRoot, 'dist', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'legacy');
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), JSON.stringify({
    schemaVersion: PROVENANCE_SCHEMA,
    oneClawVersion: '0.3.9',
    sourceDirty: false,
  }));
  const provenance = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  assert.equal(provenance.integrity, 'unavailable');
  assert.equal(provenance.integrityReason, 'missing_dist_digest');
  assert.equal((await new LocalRuntime({ entry, dataDir: resourcesPath, provenance }).start('', '', false)).status, 'error');

  fs.rmSync(path.join(runtimeRoot, 'runtime-provenance.json'));
  const missing = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  assert.equal(missing.integrityReason, 'provenance_missing_or_invalid');
  assert.equal((await new LocalRuntime({ entry, dataDir: resourcesPath, provenance: missing }).start('', '', false)).status, 'error');
});

test('runtime digest rejects links that can escape the packaged tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, '..', `${path.basename(root)}-outside.js`);
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.writeFileSync(outside, 'module.exports = true;');
  fs.symlinkSync(outside, path.join(root, 'index.js'));
  assert.throws(() => digestRuntimeTree(root), /symbolic link/);

  const linkedRoot = `${root}-root-link`;
  t.after(() => fs.rmSync(linkedRoot, { force: true }));
  fs.symlinkSync(root, linkedRoot);
  assert.throws(() => digestRuntimeTree(linkedRoot), /not a real directory/);
});

test('a packaged tree that cannot be digested is refused instead of running unverified', async (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-unreadable-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const runtimeRoot = path.join(resourcesPath, 'oneclaw');
  const dist = path.join(runtimeRoot, 'dist');
  const entry = path.join(dist, 'index.js');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(entry, 'original');
  const receipt = {
    schemaVersion: PROVENANCE_SCHEMA,
    oneClawVersion: '0.4.0',
    oneClawCommit: 'a'.repeat(40),
    sourceDirty: false,
    distDigest: digestRuntimeTree(dist),
  };
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), JSON.stringify(receipt));
  fs.rmSync(dist, { recursive: true });
  fs.symlinkSync(resourcesPath, dist);

  const provenance = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  assert.equal(provenance.integrity, 'unavailable');
  assert.equal(provenance.integrityReason, 'dist_digest_unreadable');
  assert.equal((await new LocalRuntime({ entry, dataDir: resourcesPath, provenance }).start('', '', false)).status, 'error');
});
