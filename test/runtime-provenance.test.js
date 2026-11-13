'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalRuntime } = require('../src/runtime');
const { loadRuntimeProvenance, PROVENANCE_SCHEMA } = require('../src/runtime-provenance');

test('runtime provenance is bound to the exact packaged OneClaw entry', (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-provenance-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const runtimeRoot = path.join(resourcesPath, 'oneclaw');
  const entry = path.join(runtimeRoot, 'dist', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '');
  const receipt = {
    schemaVersion: PROVENANCE_SCHEMA,
    oneClawVersion: '0.4.0',
    oneClawCommit: 'a'.repeat(40),
    sourceDirty: false,
    distDigest: `sha256:${'b'.repeat(64)}`,
  };
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), `${JSON.stringify(receipt)}\n`);

  assert.deepEqual(loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath }), receipt);
  assert.equal(loadRuntimeProvenance({ entry: path.join(resourcesPath, 'custom.js'), isPackaged: true, resourcesPath }), null);
  assert.equal(loadRuntimeProvenance({ entry, isPackaged: false, resourcesPath }), null);

  const runtime = new LocalRuntime({ entry, dataDir: resourcesPath, provenance: receipt });
  assert.equal(runtime.provenance, receipt);
});
