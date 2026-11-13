'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROVENANCE_SCHEMA = 'theone.desktop_runtime_provenance.v1';

/**
 * Read a fingerprint only when it belongs to the exact packaged entry that
 * will run. Development and custom entries have no matching signed bundle
 * receipt, so returning null is more truthful than showing a stale one.
 */
function loadRuntimeProvenance({ entry, isPackaged, resourcesPath }) {
  if (!isPackaged || !entry || !resourcesPath) return null;
  const runtimeRoot = path.join(resourcesPath, 'oneclaw');
  const packagedEntry = path.join(runtimeRoot, 'dist', 'index.js');
  if (path.resolve(entry) !== path.resolve(packagedEntry)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), 'utf8'));
    return value && value.schemaVersion === PROVENANCE_SCHEMA ? value : null;
  } catch {
    return null;
  }
}

module.exports = { PROVENANCE_SCHEMA, loadRuntimeProvenance };
