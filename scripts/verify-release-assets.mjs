import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLATFORMS = new Set(['mac', 'win', 'all']);

export function expectedReleaseAssets(version, platform = 'all') {
  if (!PLATFORMS.has(platform)) throw new Error(`Unknown release platform: ${platform}`);
  const mac = [
    `TheOne-${version}-arm64.dmg`,
    `TheOne-${version}-arm64.dmg.blockmap`,
    `TheOne-${version}-arm64-mac.zip`,
    `TheOne-${version}-arm64-mac.zip.blockmap`,
    'latest-mac.yml',
  ];
  const win = [
    `TheOne-Setup-${version}.exe`,
    `TheOne-Setup-${version}.exe.blockmap`,
    'latest.yml',
  ];
  return platform === 'mac' ? mac : platform === 'win' ? win : [...mac, ...win];
}

export function missingReleaseAssets(names, version, platform = 'all') {
  const present = new Set(names);
  return expectedReleaseAssets(version, platform).filter((name) => !present.has(name));
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function remoteAssetNames({ owner, repo, version, platform }) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'theone-desktop-release-verifier' };
  const token = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/v${encodeURIComponent(version)}`;
  let latestError = '';
  let latestNames = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`GitHub release query returned HTTP ${response.status}`);
      const release = await response.json();
      const names = Array.isArray(release.assets) ? release.assets.map((asset) => String(asset.name || '')) : [];
      latestNames = names;
      const missing = missingReleaseAssets(names, version, platform);
      if (!missing.length) return names;
      latestError = names.length
        ? `the release is still missing ${missing.join(', ')}`
        : 'the release has no assets';
    } catch (error) {
      latestError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (latestNames.length) return latestNames;
  throw new Error(`Could not read published release assets: ${latestError}`);
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = String(pkg.version || '').trim();
  const platform = option('--platform', 'all');
  if (!version) throw new Error('package.json has no version');
  if (!PLATFORMS.has(platform)) throw new Error(`Unknown release platform: ${platform}`);

  const releaseDir = path.resolve(option('--dir', 'release'));
  const localNames = fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir) : [];
  const missingLocal = missingReleaseAssets(localNames, version, platform);
  if (missingLocal.length) throw new Error(`Local release is incomplete for ${platform}: ${missingLocal.join(', ')}`);

  const metadata = platform === 'mac' ? ['latest-mac.yml'] : platform === 'win' ? ['latest.yml'] : ['latest-mac.yml', 'latest.yml'];
  for (const name of metadata) {
    const text = fs.readFileSync(path.join(releaseDir, name), 'utf8');
    if (!text.includes(`version: ${version}`)) throw new Error(`${name} does not describe version ${version}`);
    for (const asset of expectedReleaseAssets(version, name === 'latest-mac.yml' ? 'mac' : 'win')) {
      if (asset.endsWith('.yml') || asset.endsWith('.blockmap')) continue;
      if (!text.includes(asset)) throw new Error(`${name} does not reference ${asset}`);
    }
  }

  if (process.argv.includes('--remote')) {
    const names = await remoteAssetNames({ owner: 'weareoneconnection', repo: 'theonedesktop', version, platform });
    const missingRemote = missingReleaseAssets(names, version, platform);
    if (missingRemote.length) throw new Error(`GitHub release v${version} is incomplete for ${platform}: ${missingRemote.join(', ')}`);
  }
  console.log(`release v${version} assets verified (${platform}${process.argv.includes('--remote') ? ', local + GitHub' : ', local'})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
