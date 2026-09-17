// Copies the OneClaw runtime into resources/oneclaw for packaging:
// the compiled dist/, package.json, and production dependencies only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve(process.env.ONECLAW_DIR || '../oneclaw-v5-phase4');
const target = path.resolve('resources/oneclaw');

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
// Never ship an env file: the app builds the runtime's environment itself.
for (const leftover of ['.env', '.env.local', '.env.example']) fs.rmSync(path.join(target, leftover), { force: true });
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit' });
console.log(`runtime bundled into ${target}`);
