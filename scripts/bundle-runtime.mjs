// Copies the OneClaw runtime into resources/oneclaw for packaging:
// the compiled dist/, package.json, and production dependencies only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import runtimeProvenance from '../src/runtime-provenance.js';
import { assertReleaseSource } from './runtime-release-source.mjs';

const { digestRuntimeTree } = runtimeProvenance;

// Keep the packaged runtime aligned with the maintained OneClaw checkout used
// by the coding conversation. CI/release may still provide ONECLAW_DIR for a
// pinned source, but a local desktop package must not silently fall back to an
// obsolete phase directory.
const source = path.resolve(process.env.ONECLAW_DIR || '../oneclaw-v5-phase4');
const target = path.resolve('resources/oneclaw');
const releaseMode = process.argv.includes('--release');
// --os=win32 --cpu=x64 when packaging for another platform than this one:
// npm then installs that platform's optional native packages, not this Mac's.
const platformFlags = process.argv.slice(2).filter((arg) => /^--(os|cpu)=[a-z0-9]+$/.test(arg));

const gitText = (args) => {
  try { return String(execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); }
  catch { return ''; }
};
const sourceStatus = () => gitText([
  'status', '--short', '--untracked-files=all', '--',
  'src', 'contracts', 'package.json', 'package-lock.json', 'tsconfig.json',
]);
const actualCommit = gitText(['rev-parse', 'HEAD']);
assertReleaseSource({
  releaseMode,
  expectedCommit: process.env.ONECLAW_RELEASE_COMMIT,
  actualCommit,
  sourceDirty: Boolean(sourceStatus()),
});

// TypeScript does not remove files that no longer have a source counterpart.
// A release must never carry stale code left by an earlier checkout/build.
fs.rmSync(path.join(source, 'dist'), { recursive: true, force: true });
execFileSync('npm', ['run', 'build'], { cwd: source, stdio: 'inherit' });
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(source, 'dist'), path.join(target, 'dist'), {
  recursive: true,
  // Tests and type declarations are not needed at runtime.
  filter: (file) => !/\.test\.(js|d\.ts)$/.test(file) && !file.endsWith('.d.ts') && !file.endsWith('.map'),
});
for (const file of ['package.json', 'package-lock.json']) {
  if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(target, file));
}

// The runtime ships inside a public installer, and its source repository is
// private. Every script is minified and obfuscated so the shipped code is not
// readable at a glance. This raises the cost of reading it; it does not stop
// a determined reverse engineer, and nothing secret may rely on it (no keys
// are in the code: the app builds the runtime's environment itself).
// ONECLAW_OBFUSCATE=0 skips it for a local debugging build.
if (process.env.ONECLAW_OBFUSCATE !== '0') {
  const { default: JavaScriptObfuscator } = await import('javascript-obfuscator');
  const options = {
    target: 'node', compact: true, simplify: true,
    identifierNamesGenerator: 'hexadecimal',
    // Exports, globals and property names are what other files and Node see:
    // renaming them would break the runtime.
    renameGlobals: false, renameProperties: false, transformObjectKeys: false,
    stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 0.75,
    stringArrayRotate: true, stringArrayShuffle: true, splitStrings: false,
    // These cost runtime speed on every request for little extra protection.
    controlFlowFlattening: false, deadCodeInjection: false, selfDefending: false,
    numbersToExpressions: false, unicodeEscapeSequence: false,
    sourceMap: false,
  };
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith('.js') ? [full] : [];
  });
  const files = walk(path.join(target, 'dist'));
  let before = 0;
  let after = 0;
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const obfuscated = JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode();
    before += code.length;
    after += obfuscated.length;
    fs.writeFileSync(file, obfuscated);
  }
  console.log(`obfuscated ${files.length} runtime files (${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB)`);
}

// Never ship an env file: the app builds the runtime's environment itself.
for (const leftover of ['.env', '.env.local', '.env.example']) fs.rmSync(path.join(target, leftover), { force: true });
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...platformFlags], { cwd: target, stdio: 'inherit' });
const sourcePackage = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
const provenance = {
  schemaVersion: 'theone.desktop_runtime_provenance.v1',
  oneClawVersion: String(sourcePackage.version || ''),
  oneClawCommit: actualCommit || null,
  // Include untracked build inputs but ignore unrelated local artifacts such
  // as eval results. A package made from an uncommitted source/dist/config
  // tree must never advertise itself as a clean commit build.
  sourceDirty: Boolean(sourceStatus()),
  releasePinned: releaseMode,
  distDigest: digestRuntimeTree(path.join(target, 'dist')),
};
fs.writeFileSync(path.join(target, 'runtime-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`runtime bundled into ${target}${platformFlags.length ? ` (${platformFlags.join(' ')})` : ''}; commit=${provenance.oneClawCommit || 'unknown'} dirty=${provenance.sourceDirty} digest=${provenance.distDigest}`);
