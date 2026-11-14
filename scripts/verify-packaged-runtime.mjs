import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import runtimeProvenance from '../src/runtime-provenance.js';

const { loadRuntimeProvenance } = runtimeProvenance;

export function packagedResourcesPath(platform, releaseDir = path.resolve('release')) {
  if (platform === 'mac') return path.join(releaseDir, 'mac-arm64', 'TheOne.app', 'Contents', 'Resources');
  if (platform === 'win') return path.join(releaseDir, 'win-unpacked', 'resources');
  throw new Error(`Unknown packaged-runtime platform: ${platform}`);
}

export function verifyPackagedRuntime({ platform, releaseDir = path.resolve('release'), expectedCommit }) {
  if (!/^[a-f0-9]{40}$/i.test(String(expectedCommit || ''))) {
    throw new Error('Packaged runtime verification requires ONECLAW_RELEASE_COMMIT.');
  }
  const resourcesPath = packagedResourcesPath(platform, releaseDir);
  const entry = path.join(resourcesPath, 'oneclaw', 'dist', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`Packaged OneClaw entry is missing: ${entry}`);
  const receipt = loadRuntimeProvenance({ entry, isPackaged: true, resourcesPath });
  if (!receipt) throw new Error('Packaged OneClaw provenance is missing or invalid.');
  if (receipt.integrity !== 'verified') throw new Error(`Packaged OneClaw integrity is ${receipt.integrity || 'unknown'} (${receipt.integrityReason || 'no reason'}).`);
  if (receipt.sourceDirty !== false) throw new Error('Packaged OneClaw provenance does not prove a clean release source.');
  if (receipt.releasePinned !== true) throw new Error('Packaged OneClaw provenance is not marked as release-pinned.');
  if (String(receipt.oneClawCommit || '').toLowerCase() !== String(expectedCommit).toLowerCase()) {
    throw new Error(`Packaged OneClaw commit mismatch: expected ${expectedCommit}, found ${receipt.oneClawCommit || 'unknown'}.`);
  }
  return receipt;
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const platform = option('--platform', '');
    const receipt = verifyPackagedRuntime({ platform, expectedCommit: process.env.ONECLAW_RELEASE_COMMIT });
    console.log(`packaged OneClaw verified (${platform}; commit=${receipt.oneClawCommit}; digest=${receipt.distDigest})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
