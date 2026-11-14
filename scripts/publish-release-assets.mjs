import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectedReleaseAssets, missingReleaseAssets } from './verify-release-assets.mjs';

export function publishArguments({ version, platform, releaseDir = path.resolve('release') }) {
  const names = expectedReleaseAssets(version, platform);
  const present = fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir) : [];
  const missing = missingReleaseAssets(present, version, platform);
  if (missing.length) throw new Error(`Refusing to publish an incomplete ${platform} release: ${missing.join(', ')}`);
  for (const name of names) {
    const file = path.join(releaseDir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
      throw new Error(`Refusing to publish an invalid release asset: ${name}`);
    }
  }
  return [
    'publish', '--policy', 'always', '--version', version,
    ...names.flatMap((name) => ['--files', path.join(releaseDir, name)]),
  ];
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const platform = option('--platform', '');
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const version = String(pkg.version || '').trim();
    const args = publishArguments({ version, platform });
    const executable = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
    execFileSync(executable, args, { stdio: 'inherit' });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
