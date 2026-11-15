'use strict';

// Code signing changes Mach-O/.node bytes after afterPack. Refresh the receipt
// only after every packaged runtime binary has its final signature.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

async function refreshRuntimeProvenance(runtimeRoot) {
  const receiptPath = path.join(runtimeRoot, 'runtime-provenance.json');
  if (!fs.existsSync(receiptPath)) throw new Error('Packaged OneClaw provenance is missing.');
  const { digestRuntimeArtifact } = await import(pathToFileURL(
    path.join(__dirname, '..', 'src', 'runtime-provenance.js'),
  ).href);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.runtimeDigest = digestRuntimeArtifact(runtimeRoot);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

function resealMacApp(appPath, identity) {
  execFileSync('codesign', [
    '--deep',
    '--force',
    '--verbose',
    '--sign',
    identity || '-',
    appPath,
  ], { stdio: 'inherit' });
}

// Order matters. The receipt digest covers node_modules, which holds the
// packaged .node binaries: the deep signature rewrites their bytes. So the
// nested binaries are signed FIRST, the digest is taken from the final bytes,
// and only the outer bundle is sealed again (no --deep, so nested code is not
// re-signed and its digest stays valid). The receipt itself is excluded from
// the digest, so writing it before the outer seal is safe.
function resealOuterMacApp(appPath, identity) {
  execFileSync('codesign', ['--force', '--verbose', '--sign', identity || '-', appPath], { stdio: 'inherit' });
}

async function verifyReceipt(runtimeRoot) {
  const { digestRuntimeArtifact } = await import(pathToFileURL(
    path.join(__dirname, '..', 'src', 'runtime-provenance.js'),
  ).href);
  const receipt = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'runtime-provenance.json'), 'utf8'));
  const actual = digestRuntimeArtifact(runtimeRoot);
  if (actual !== receipt.runtimeDigest) {
    throw new Error(`Packaged OneClaw receipt does not match the final bytes (${actual} != ${receipt.runtimeDigest}).`);
  }
}

exports.default = async function afterSign(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const runtimeRoot = path.join(resources, 'oneclaw');
  if (context.electronPlatformName === 'darwin') {
    const appPath = path.dirname(path.dirname(resources));
    const identity = context.packager.platformSpecificBuildOptions?.identity || '-';
    // 1. Nested binaries get their final signature.
    resealMacApp(appPath, identity);
    // 2. The digest is taken from those final bytes.
    await refreshRuntimeProvenance(runtimeRoot);
    // 3. Seal the outer bundle again so it covers the refreshed receipt;
    //    nested binaries are not touched.
    resealOuterMacApp(appPath, identity);
  } else {
    await refreshRuntimeProvenance(runtimeRoot);
  }
  await verifyReceipt(runtimeRoot);
};
