'use strict';

/**
 * Codex, installed by TheOne when a person first wants it.
 *
 * Codex's CLI is about 130 MB compressed (the binary alone is 229 MB), too
 * much to put in every installer when most people never use it. So the app
 * downloads one pinned version into its own data folder on request, from npm
 * or, when that is slow or blocked, its mainland China mirror.
 *
 * The package is checked against the SHA-512 pinned here, not only the one
 * the registry reports: a mirror that served something else is refused. The
 * voice resources (20 MB) are not unpacked; TheOne does not use them.
 *
 * Updating Codex is a new version here, with its integrity, in an app release.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CODEX_VERSION = '0.158.0';

/** Per platform: the npm package's suffix, the folder inside it, and its pinned integrity. */
const PACKAGES = {
  'darwin-arm64': { suffix: 'darwin-arm64', target: 'aarch64-apple-darwin', integrity: 'sha512-0OKSjlWY1j4Ld1fT87QttNw3Y2SthcXi4GcrWSHjleZg1n86eG3+shJl4Pv+siUmsBJhWlNmm6rRO4Yv8ZyQLg==' },
  'darwin-x64': { suffix: 'darwin-x64', target: 'x86_64-apple-darwin', integrity: 'sha512-FrX1o3APrL7F6QkO8z08Rq8lJitH2sNI7pkebA02eYA103hDs3fyy9d32zeLLQJUeAhmZA4pV9xJR4m7cVyNpQ==' },
  'win32-x64': { suffix: 'win32-x64', target: 'x86_64-pc-windows-msvc', binary: 'codex.exe', integrity: 'sha512-IaUmY11Zdqa/Zok6kE0Z5375pXtClKRbS8P1Gh2C73Aq65CaGn9N8gT6BXGC3+XD6yamAIiEQW5xM842UCCGow==' },
  'win32-arm64': { suffix: 'win32-arm64', target: 'aarch64-pc-windows-msvc', binary: 'codex.exe', integrity: 'sha512-Jw1u0q0+5PG97jPkINxE3UCFtsYBN8Af+IjjM0zlCO675Sv5lNsXU2K9aIaXwVeQIKw8q2lbPAR4SEkq2rSOoA==' },
};

const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

function codexPackage(platform = process.platform, arch = process.arch, packages = PACKAGES) {
  return packages[`${platform}-${arch}`] || null;
}

function codexInstallDir(dataDir) {
  return path.join(dataDir, 'codex', CODEX_VERSION);
}

/** The installed binary, when a complete install of this version is there. */
function installedCodexPath(dataDir, platform = process.platform, arch = process.arch, packages = PACKAGES) {
  const pkg = codexPackage(platform, arch, packages);
  if (!pkg || !dataDir) return null;
  const dir = codexInstallDir(dataDir);
  const binary = path.join(dir, 'vendor', pkg.target, 'bin', pkg.binary || 'codex');
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.theone-installed.json'), 'utf8'));
    // Windows has no execute bit: the file being there is the test.
    fs.accessSync(binary, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return marker.version === CODEX_VERSION ? binary : null;
  } catch {
    return null;
  }
}

/** The registries to try, an explicit one first (THEONE_NPM_REGISTRY). */
function registries(env = process.env) {
  const own = String(env.THEONE_NPM_REGISTRY || '').trim().replace(/\/+$/, '');
  return [...new Set([own, ...REGISTRIES].filter(Boolean))];
}

function tarballUrl(registry, pkg) {
  return `${registry}/@openai/codex/-/codex-${CODEX_VERSION}-${pkg.suffix}.tgz`;
}

/** Download to `file`, hashing as it goes; resolves to the SRI string. */
async function download(url, file, { fetchFn, onProgress, signal }) {
  const response = await fetchFn(url, { signal });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(file);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress({ phase: 'download', received, total });
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  return `sha512-${hash.digest('base64')}`;
}

/** bsdtar: /usr/bin/tar on macOS, System32\\tar.exe on Windows 10 and later. */
function tarCommand(platform = process.platform, env = process.env) {
  return platform === 'win32' ? path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
}

function extract(archive, into, { spawnFn, platform }) {
  return new Promise((resolve, reject) => {
    // The voice resources are left in the archive.
    const child = spawnFn(tarCommand(platform), ['-xzf', archive, '-C', into, '--exclude', 'package/vendor/*/codex-resources/voice'], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
}

/**
 * Install Codex into the data folder and return the binary. Already installed
 * returns it at once. Progress: { phase: 'download' | 'verify' | 'extract' | 'done', received, total, registry }.
 */
async function installCodex({ dataDir, env = process.env, fetchFn = fetch, spawnFn = spawn, onProgress = () => {}, platform = process.platform, arch = process.arch, signal, packages = PACKAGES } = {}) {
  const existing = installedCodexPath(dataDir, platform, arch, packages);
  if (existing) return { binary: existing, version: CODEX_VERSION, already: true };
  const pkg = codexPackage(platform, arch, packages);
  if (!pkg) throw Object.assign(new Error(`Codex is not available for ${platform}-${arch}.`), { code: 'codex_unsupported' });

  const root = path.join(dataDir, 'codex');
  fs.mkdirSync(root, { recursive: true });
  const archive = path.join(root, `.download-${process.pid}-${Date.now()}.tgz`);
  const staging = path.join(root, `.staging-${process.pid}-${Date.now()}`);
  const failures = [];
  try {
    let verified = false;
    for (const registry of registries(env)) {
      try {
        onProgress({ phase: 'download', received: 0, total: 0, registry });
        const integrity = await download(tarballUrl(registry, pkg), archive, { fetchFn, onProgress: (p) => onProgress({ ...p, registry }), signal });
        onProgress({ phase: 'verify', registry });
        if (integrity !== pkg.integrity) throw new Error('integrity mismatch');
        verified = true;
        break;
      } catch (error) {
        failures.push(`${registry}: ${error.message || error}`);
        fs.rmSync(archive, { force: true });
        if (signal && signal.aborted) throw error;
      }
    }
    if (!verified) throw Object.assign(new Error(`Could not download Codex (${failures.join('; ')}).`), { code: 'codex_download_failed' });

    onProgress({ phase: 'extract' });
    fs.mkdirSync(staging, { recursive: true });
    await extract(archive, staging, { spawnFn, platform });
    const unpacked = path.join(staging, 'package');
    fs.writeFileSync(path.join(unpacked, '.theone-installed.json'), JSON.stringify({ version: CODEX_VERSION, integrity: pkg.integrity, installedAt: new Date().toISOString() }));
    const dir = codexInstallDir(dataDir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(unpacked, dir);
    const binary = installedCodexPath(dataDir, platform, arch, packages);
    if (!binary) throw new Error('Codex was unpacked but its binary is not runnable.');
    onProgress({ phase: 'done' });
    return { binary, version: CODEX_VERSION, already: false };
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { CODEX_VERSION, PACKAGES, codexInstallDir, codexPackage, installCodex, installedCodexPath, registries, tarballUrl, tarCommand };
