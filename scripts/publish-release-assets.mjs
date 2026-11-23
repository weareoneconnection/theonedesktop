import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expectedReleaseAssets, missingReleaseAssets } from './verify-release-assets.mjs';

/** The already-built files a release uploads; refuses an incomplete or invalid set. */
export function publishFiles({ version, platform, releaseDir = path.resolve('release') }) {
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
  return names.map((name) => path.join(releaseDir, name));
}

/**
 * The GitHub publish target in package.json. It must be a single object, not
 * a one-item array: electron-builder 26 merges the config twice when
 * publishing, and merging an array into itself yields `{"0": ..., length: 1}`,
 * which fails schema validation, so nothing can be published.
 */
export function publishConfiguration(pkg) {
  const configured = pkg?.build?.publish;
  if (Array.isArray(configured)) throw new Error('package.json build.publish must be a single object, not an array (electron-builder cannot publish an array config).');
  if (!configured || configured.provider !== 'github') throw new Error('package.json build.publish has no GitHub publish target.');
  return configured;
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
    const files = publishFiles({ version, platform });
    publishConfiguration(pkg);
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) throw new Error('Set GH_TOKEN (for example GH_TOKEN="$(gh auth token)") to publish.');
    const { publishArtifactsWithOptions } = createRequire(import.meta.url)('electron-builder');
    const published = await publishArtifactsWithOptions(files.map((file) => ({ file, arch: null })), version, null, undefined, { publish: 'always' });
    // electron-builder logs an upload failure and resolves null instead of throwing.
    if (!published) throw new Error(`Publishing the ${platform} release failed; see the electron-builder error above.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
