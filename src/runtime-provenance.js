'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROVENANCE_SCHEMA = 'theone.desktop_runtime_provenance.v1';

/**
 * Digest a runtime tree exactly as the bundler does: sorted relative paths and
 * bytes, with separators between each value. Exported so release preflight and
 * the installed app verify the same artifact with the same algorithm.
 */
function digestRuntimeTree(root) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Runtime tree root is not a real directory: ${root}`);
  }
  const hash = crypto.createHash('sha256');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    // Locale collation can differ between the release machine and an installed
    // machine. Code-point order keeps the digest cross-platform deterministic.
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      const stat = fs.lstatSync(file);
      // A packaged JS tree has no reason to contain links. Hashing the target
      // bytes would let a link escape the verified tree at execution time.
      if (stat.isSymbolicLink()) throw new Error(`Runtime tree contains a symbolic link: ${file}`);
      if (stat.isDirectory()) return walk(file);
      if (!stat.isFile()) throw new Error(`Runtime tree contains an unsupported entry: ${file}`);
      return [file];
    });
  for (const file of walk(root)) {
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function compactProvenance(value) {
  const version = typeof value.oneClawVersion === 'string' ? value.oneClawVersion.trim().slice(0, 100) : '';
  const commit = typeof value.oneClawCommit === 'string' && /^[a-f0-9]{40}$/i.test(value.oneClawCommit)
    ? value.oneClawCommit.toLowerCase()
    : null;
  const digest = typeof value.distDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.distDigest)
    ? value.distDigest
    : null;
  return {
    schemaVersion: PROVENANCE_SCHEMA,
    oneClawVersion: version,
    oneClawCommit: commit,
    ...(typeof value.sourceDirty === 'boolean' ? { sourceDirty: value.sourceDirty } : {}),
    ...(typeof value.releasePinned === 'boolean' ? { releasePinned: value.releasePinned } : {}),
    distDigest: digest,
  };
}

function withIntegrity(rawValue, distRoot) {
  const value = compactProvenance(rawValue);
  const expected = value.distDigest;
  if (!expected) {
    // The caller reports the reason and the packaged runtime refuses to start.
    return { ...value, integrity: 'unavailable', actualDistDigest: null, integrityReason: 'missing_dist_digest' };
  }
  try {
    const actual = digestRuntimeTree(distRoot);
    return {
      ...value,
      integrity: actual === expected ? 'verified' : 'mismatch',
      actualDistDigest: actual,
      integrityReason: actual === expected ? null : 'dist_digest_mismatch',
    };
  } catch {
    return { ...value, integrity: 'unavailable', actualDistDigest: null, integrityReason: 'dist_digest_unreadable' };
  }
}

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
    return value && value.schemaVersion === PROVENANCE_SCHEMA
      ? withIntegrity(value, path.join(runtimeRoot, 'dist'))
      : {
          schemaVersion: PROVENANCE_SCHEMA,
          integrity: 'unavailable',
          actualDistDigest: null,
          integrityReason: 'provenance_missing_or_invalid',
        };
  } catch {
    // `null` is reserved for development or an explicit custom entry. The
    // default packaged entry must carry a valid receipt so deleting it cannot
    // turn verification off.
    return {
      schemaVersion: PROVENANCE_SCHEMA,
      integrity: 'unavailable',
      actualDistDigest: null,
      integrityReason: 'provenance_missing_or_invalid',
    };
  }
}

module.exports = { PROVENANCE_SCHEMA, digestRuntimeTree, loadRuntimeProvenance };
