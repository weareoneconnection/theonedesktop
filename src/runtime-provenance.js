'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROVENANCE_SCHEMA = 'theone.desktop_runtime_provenance.v2';
const LEGACY_PROVENANCE_SCHEMA = 'theone.desktop_runtime_provenance.v1';
const RECEIPT_FILE = 'runtime-provenance.json';
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function sortedFiles(root, ignore = new Set()) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Runtime tree root is not a real directory: ${root}`);
  }
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (ignore.has(relative)) return [];
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Runtime tree contains a symbolic link: ${file}`);
      if (stat.isDirectory()) return walk(file);
      if (!stat.isFile()) throw new Error(`Runtime tree contains an unsupported entry: ${file}`);
      return [file];
    });
  return walk(root);
}

function digestFiles(root, files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Digest an arbitrary strict tree. Kept for v1 receipts and focused tests. */
function digestRuntimeTree(root) {
  return digestFiles(root, sortedFiles(root));
}

/**
 * Digest every executable runtime input, excluding only the receipt that holds
 * the digest. package metadata, lockfile and production dependencies are now
 * bound alongside dist/; any symlink is rejected rather than followed.
 */
function digestRuntimeArtifact(runtimeRoot) {
  for (const relative of ['dist', 'node_modules', 'package.json', 'package-lock.json']) {
    const target = path.join(runtimeRoot, relative);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Runtime artifact contains a symbolic link: ${target}`);
    if ((relative === 'dist' || relative === 'node_modules') ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Runtime artifact has an invalid required entry: ${target}`);
    }
  }
  return digestFiles(runtimeRoot, sortedFiles(runtimeRoot, new Set([RECEIPT_FILE])));
}

function digestFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Runtime manifest input is not a real file: ${file}`);
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function compactProvenance(value) {
  const schemaVersion = value.schemaVersion === LEGACY_PROVENANCE_SCHEMA ? LEGACY_PROVENANCE_SCHEMA : PROVENANCE_SCHEMA;
  const version = typeof value.oneClawVersion === 'string' ? value.oneClawVersion.trim().slice(0, 100) : '';
  const commit = typeof value.oneClawCommit === 'string' && /^[a-f0-9]{40}$/i.test(value.oneClawCommit)
    ? value.oneClawCommit.toLowerCase()
    : null;
  const distDigest = typeof value.distDigest === 'string' && SHA256.test(value.distDigest) ? value.distDigest : null;
  const runtimeDigest = typeof value.runtimeDigest === 'string' && SHA256.test(value.runtimeDigest) ? value.runtimeDigest : null;
  const lockDigest = typeof value.packageLockDigest === 'string' && SHA256.test(value.packageLockDigest) ? value.packageLockDigest : null;
  return {
    schemaVersion,
    oneClawVersion: version,
    oneClawCommit: commit,
    ...(typeof value.desktopVersion === 'string' ? { desktopVersion: value.desktopVersion.slice(0, 100) } : {}),
    ...(typeof value.platform === 'string' ? { platform: value.platform.slice(0, 40) } : {}),
    ...(typeof value.arch === 'string' ? { arch: value.arch.slice(0, 40) } : {}),
    ...(typeof value.sourceDirty === 'boolean' ? { sourceDirty: value.sourceDirty } : {}),
    ...(typeof value.releasePinned === 'boolean' ? { releasePinned: value.releasePinned } : {}),
    distDigest,
    ...(schemaVersion === PROVENANCE_SCHEMA ? { runtimeDigest, packageLockDigest: lockDigest } : {}),
  };
}

function unavailable(value, reason) {
  return { ...value, integrity: 'unavailable', actualDistDigest: null, actualRuntimeDigest: null, integrityReason: reason };
}

function withIntegrity(rawValue, runtimeRoot, expected = {}) {
  const value = compactProvenance(rawValue);
  if (value.platform && expected.platform && value.platform !== expected.platform) return unavailable(value, 'runtime_platform_mismatch');
  if (value.arch && expected.arch && value.arch !== expected.arch) return unavailable(value, 'runtime_arch_mismatch');
  if (value.desktopVersion && expected.desktopVersion && value.desktopVersion !== expected.desktopVersion) return unavailable(value, 'desktop_version_mismatch');

  if (value.schemaVersion === LEGACY_PROVENANCE_SCHEMA) {
    // Desktop 0.4.39+ always supplies its own version here. Accepting a v1
    // dist-only receipt in that app would let a modified package downgrade
    // around the v2 dependency/lockfile/platform checks. The no-version path
    // remains only for legacy-focused tooling and tests.
    if (expected.desktopVersion) return unavailable(value, 'legacy_provenance_not_allowed');
    if (!value.distDigest) return unavailable(value, 'missing_dist_digest');
    try {
      const actualDistDigest = digestRuntimeTree(path.join(runtimeRoot, 'dist'));
      return {
        ...value,
        integrity: actualDistDigest === value.distDigest ? 'verified' : 'mismatch',
        actualDistDigest,
        actualRuntimeDigest: null,
        integrityReason: actualDistDigest === value.distDigest ? null : 'dist_digest_mismatch',
      };
    } catch {
      return unavailable(value, 'dist_digest_unreadable');
    }
  }

  if (!value.runtimeDigest) return unavailable(value, 'missing_runtime_digest');
  if (!value.packageLockDigest) return unavailable(value, 'missing_package_lock_digest');
  try {
    const actualDistDigest = digestRuntimeTree(path.join(runtimeRoot, 'dist'));
    const actualRuntimeDigest = digestRuntimeArtifact(runtimeRoot);
    const actualLockDigest = digestFile(path.join(runtimeRoot, 'package-lock.json'));
    const verified = actualRuntimeDigest === value.runtimeDigest
      && actualLockDigest === value.packageLockDigest
      && (!value.distDigest || actualDistDigest === value.distDigest);
    return {
      ...value,
      integrity: verified ? 'verified' : 'mismatch',
      actualDistDigest,
      actualRuntimeDigest,
      integrityReason: verified ? null
        : actualLockDigest !== value.packageLockDigest ? 'package_lock_digest_mismatch'
          : actualRuntimeDigest !== value.runtimeDigest ? 'runtime_digest_mismatch'
            : 'dist_digest_mismatch',
    };
  } catch {
    return unavailable(value, 'runtime_digest_unreadable');
  }
}

function invalidProvenance() {
  return {
    schemaVersion: PROVENANCE_SCHEMA,
    integrity: 'unavailable',
    actualDistDigest: null,
    actualRuntimeDigest: null,
    integrityReason: 'provenance_missing_or_invalid',
  };
}

/** Read a fingerprint only when it belongs to the exact packaged entry. */
function loadRuntimeProvenance({ entry, isPackaged, resourcesPath, desktopVersion, platform = process.platform, arch = process.arch }) {
  if (!isPackaged || !entry || !resourcesPath) return null;
  const runtimeRoot = path.join(resourcesPath, 'oneclaw');
  const packagedEntry = path.join(runtimeRoot, 'dist', 'index.js');
  if (path.resolve(entry) !== path.resolve(packagedEntry)) return null;
  try {
    const receiptPath = path.join(runtimeRoot, RECEIPT_FILE);
    const receiptStat = fs.lstatSync(receiptPath);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) return invalidProvenance();
    const value = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (!value || ![PROVENANCE_SCHEMA, LEGACY_PROVENANCE_SCHEMA].includes(value.schemaVersion)) return invalidProvenance();
    return withIntegrity(value, runtimeRoot, { desktopVersion, platform, arch });
  } catch {
    return invalidProvenance();
  }
}

module.exports = {
  LEGACY_PROVENANCE_SCHEMA,
  PROVENANCE_SCHEMA,
  digestFile,
  digestRuntimeArtifact,
  digestRuntimeTree,
  loadRuntimeProvenance,
};
