'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalRuntime } = require('../src/runtime');
const { digestFile, digestRuntimeArtifact, digestRuntimeTree, loadRuntimeProvenance, PROVENANCE_SCHEMA } = require('../src/runtime-provenance');

function runtimeFixture(resourcesPath, source = 'module.exports = true;') {
  const runtimeRoot = path.join(resourcesPath, 'oneclaw');
  const entry = path.join(runtimeRoot, 'dist', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, 'node_modules', 'fixture'), { recursive: true });
  fs.writeFileSync(entry, source);
  fs.writeFileSync(path.join(runtimeRoot, 'node_modules', 'fixture', 'index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(runtimeRoot, 'package.json'), '{"name":"fixture"}');
  fs.writeFileSync(path.join(runtimeRoot, 'package-lock.json'), '{"lockfileVersion":3}');
  return { runtimeRoot, entry };
}

function v2Receipt(runtimeRoot, extra = {}) {
  return {
    schemaVersion: PROVENANCE_SCHEMA,
    desktopVersion: '0.4.38',
    oneClawVersion: '0.4.0',
    oneClawCommit: 'a'.repeat(40),
    platform: process.platform,
    arch: process.arch,
    sourceDirty: false,
    distDigest: digestRuntimeTree(path.join(runtimeRoot, 'dist')),
    packageLockDigest: digestFile(path.join(runtimeRoot, 'package-lock.json')),
    runtimeDigest: digestRuntimeArtifact(runtimeRoot),
    ...extra,
  };
}

test('runtime provenance is bound to the exact packaged OneClaw entry', (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const { runtimeRoot, entry } = runtimeFixture(resourcesPath);
  const receipt = v2Receipt(runtimeRoot, { unreviewed: 'must not cross the bridge' });
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), `${JSON.stringify(receipt)}\n`);

  const loaded = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath, desktopVersion: '0.4.38' });
  assert.equal(loaded.integrity, 'verified');
  assert.equal(loaded.runtimeDigest, receipt.runtimeDigest);
  assert.equal(loaded.actualRuntimeDigest, receipt.runtimeDigest);
  assert.equal(loaded.unreviewed, undefined);
  assert.equal(loadRuntimeProvenance({ entry: path.join(resourcesPath, 'custom.js'), isPackaged: true, resourcesPath }), null);
  assert.equal(loadRuntimeProvenance({ entry, isPackaged: false, resourcesPath }), null);

  const provenance = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  const runtime = new LocalRuntime({ entry, dataDir: resourcesPath, provenance });
  assert.equal(runtime.provenance.integrity, 'verified');
});

test('runtime provenance detects changed bytes and the runtime refuses them', async (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-mismatch-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const { runtimeRoot, entry } = runtimeFixture(resourcesPath, 'original');
  const receipt = v2Receipt(runtimeRoot);
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), `${JSON.stringify(receipt)}\n`);
  fs.writeFileSync(entry, 'tampered');

  const provenance = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  assert.equal(provenance.integrity, 'mismatch');
  assert.notEqual(provenance.actualRuntimeDigest, receipt.runtimeDigest);
  const runtime = new LocalRuntime({ entry, dataDir: resourcesPath, provenance });
  assert.deepEqual(await runtime.start('', '', false), {
    status: 'error', error: 'Packaged OneClaw code failed its digest check.',
  });
});

test('the default packaged runtime fails closed when its receipt is missing or incomplete', async (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-legacy-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const { runtimeRoot, entry } = runtimeFixture(resourcesPath, 'legacy');
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), JSON.stringify({
    schemaVersion: PROVENANCE_SCHEMA,
    oneClawVersion: '0.3.9',
    sourceDirty: false,
  }));
  const provenance = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  assert.equal(provenance.integrity, 'unavailable');
  assert.equal(provenance.integrityReason, 'missing_runtime_digest');
  assert.equal((await new LocalRuntime({ entry, dataDir: resourcesPath, provenance }).start('', '', false)).status, 'error');

  fs.rmSync(path.join(runtimeRoot, 'runtime-provenance.json'));
  const missing = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  assert.equal(missing.integrityReason, 'provenance_missing_or_invalid');
  assert.equal((await new LocalRuntime({ entry, dataDir: resourcesPath, provenance: missing }).start('', '', false)).status, 'error');
});

test('a current Desktop build cannot downgrade to a v1 dist-only receipt', (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-downgrade-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const { runtimeRoot, entry } = runtimeFixture(resourcesPath, 'legacy');
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), JSON.stringify({
    schemaVersion: 'theone.desktop_runtime_provenance.v1',
    oneClawVersion: '0.4.0',
    oneClawCommit: 'a'.repeat(40),
    sourceDirty: false,
    distDigest: digestRuntimeTree(path.join(runtimeRoot, 'dist')),
  }));

  const provenance = loadRuntimeProvenance({
    entry,
    isPackaged: true,
    resourcesPath,
    desktopVersion: '0.4.39',
  });
  assert.equal(provenance.integrity, 'unavailable');
  assert.equal(provenance.integrityReason, 'legacy_provenance_not_allowed');
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
  const { runtimeRoot, entry } = runtimeFixture(resourcesPath, 'original');
  const dist = path.join(runtimeRoot, 'dist');
  const receipt = v2Receipt(runtimeRoot);
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), JSON.stringify(receipt));
  fs.rmSync(dist, { recursive: true });
  fs.symlinkSync(resourcesPath, dist);

  const provenance = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  assert.equal(provenance.integrity, 'unavailable');
  assert.equal(provenance.integrityReason, 'runtime_digest_unreadable');
  assert.equal((await new LocalRuntime({ entry, dataDir: resourcesPath, provenance }).start('', '', false)).status, 'error');
});

test('runtime provenance binds production dependencies, lockfile and target platform', (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-runtime-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const { runtimeRoot, entry } = runtimeFixture(resourcesPath);
  const receipt = v2Receipt(runtimeRoot);
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), JSON.stringify(receipt));

  fs.writeFileSync(path.join(runtimeRoot, 'node_modules', 'fixture', 'index.js'), 'tampered dependency');
  assert.equal(loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath }).integrityReason, 'runtime_digest_mismatch');

  fs.writeFileSync(path.join(runtimeRoot, 'node_modules', 'fixture', 'index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), JSON.stringify({ ...v2Receipt(runtimeRoot), platform: 'not-this-platform' }));
  assert.equal(loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath }).integrityReason, 'runtime_platform_mismatch');
});
