'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { digestRuntimeTree, PROVENANCE_SCHEMA } = require('../src/runtime-provenance');

test('release source must be clean and pinned to the reviewed OneClaw commit', async () => {
  const { assertReleaseSource } = await import('../scripts/runtime-release-source.mjs');
  const commit = 'a'.repeat(40);
  assert.doesNotThrow(() => assertReleaseSource({ releaseMode: true, expectedCommit: commit, actualCommit: commit, sourceDirty: false }));
  assert.throws(() => assertReleaseSource({ releaseMode: true, expectedCommit: '', actualCommit: commit, sourceDirty: false }), /ONECLAW_RELEASE_COMMIT/);
  assert.throws(() => assertReleaseSource({ releaseMode: true, expectedCommit: commit, actualCommit: 'b'.repeat(40), sourceDirty: false }), /pin mismatch/);
  assert.throws(() => assertReleaseSource({ releaseMode: true, expectedCommit: commit, actualCommit: commit, sourceDirty: true }), /uncommitted/);
  assert.doesNotThrow(() => assertReleaseSource({ releaseMode: false, expectedCommit: '', actualCommit: '', sourceDirty: true }));
});

test('packaged runtime preflight verifies bytes, pin and clean provenance', async (t) => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-release-preflight-'));
  t.after(() => fs.rmSync(releaseDir, { recursive: true, force: true }));
  const resources = path.join(releaseDir, 'mac-arm64', 'TheOne.app', 'Contents', 'Resources');
  const runtimeRoot = path.join(resources, 'oneclaw');
  const dist = path.join(runtimeRoot, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.js'), 'module.exports = true;');
  const commit = 'c'.repeat(40);
  const receipt = {
    schemaVersion: PROVENANCE_SCHEMA,
    oneClawVersion: '0.4.0',
    oneClawCommit: commit,
    sourceDirty: false,
    releasePinned: true,
    distDigest: digestRuntimeTree(dist),
  };
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), JSON.stringify(receipt));

  const { verifyPackagedRuntime } = await import('../scripts/verify-packaged-runtime.mjs');
  const verified = verifyPackagedRuntime({ platform: 'mac', releaseDir, expectedCommit: commit });
  assert.equal(verified.integrity, 'verified');
  assert.throws(() => verifyPackagedRuntime({ platform: 'mac', releaseDir, expectedCommit: 'd'.repeat(40) }), /commit mismatch/);
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), JSON.stringify({ ...receipt, sourceDirty: null }));
  assert.throws(() => verifyPackagedRuntime({ platform: 'mac', releaseDir, expectedCommit: commit }), /clean release source/);
});

test('publisher receives only a complete, already-built asset set', async (t) => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-publish-preflight-'));
  t.after(() => fs.rmSync(releaseDir, { recursive: true, force: true }));
  const { expectedReleaseAssets } = await import('../scripts/verify-release-assets.mjs');
  const { publishArguments } = await import('../scripts/publish-release-assets.mjs');
  const version = '0.4.38';
  const names = expectedReleaseAssets(version, 'mac');
  for (const name of names) fs.writeFileSync(path.join(releaseDir, name), 'fixture');
  const args = publishArguments({ version, platform: 'mac', releaseDir });
  assert.deepEqual(args.slice(0, 5), ['publish', '--policy', 'always', '--version', version]);
  for (const name of names) assert.ok(args.includes(path.join(releaseDir, name)));
  fs.rmSync(path.join(releaseDir, names[0]));
  assert.throws(() => publishArguments({ version, platform: 'mac', releaseDir }), /incomplete/);

  fs.writeFileSync(path.join(releaseDir, names[0]), 'fixture');
  fs.rmSync(path.join(releaseDir, names[1]));
  fs.symlinkSync(path.join(releaseDir, names[0]), path.join(releaseDir, names[1]));
  assert.throws(() => publishArguments({ version, platform: 'mac', releaseDir }), /invalid release asset/);
});
