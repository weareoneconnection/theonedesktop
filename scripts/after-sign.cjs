'use strict';

// Code signing changes Mach-O/.node bytes after afterPack. Refresh the receipt
// only after every packaged runtime binary has its final signature.
const fs = require('node:fs');
const path = require('node:path');
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

exports.default = async function afterSign(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  await refreshRuntimeProvenance(path.join(resources, 'oneclaw'));
};
