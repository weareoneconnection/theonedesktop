// electron-builder never copies node_modules from extraResources, so the
// runtime's production dependencies are copied into the packed app here.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const target = path.join(context.appOutDir, appName, 'Contents', 'Resources', 'oneclaw', 'node_modules');
  const source = path.resolve(__dirname, '..', 'resources', 'oneclaw', 'node_modules');
  if (!fs.existsSync(source)) throw new Error('Run npm run bundle:runtime first: resources/oneclaw/node_modules is missing.');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
};
