'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { addressFromOutput, allowedFolder, createDevServers, planDevServer } = require('../src/dev-server');

function project(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theone-dev-')));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test('picks the project\'s own run script and its package manager', () => {
  const dir = project({ 'package.json': JSON.stringify({ scripts: { build: 'x', start: 's', dev: 'd' } }), 'pnpm-lock.yaml': '' });
  assert.deepEqual(planDevServer(dir), { ok: true, script: 'dev', manager: 'pnpm', command: 'pnpm run dev' });
  assert.equal(planDevServer(project({ 'package.json': JSON.stringify({ scripts: { start: 's' } }) })).command, 'npm run start');
});

test('says why it cannot start', () => {
  assert.equal(planDevServer(project({})).reason, 'no_package_json');
  assert.equal(planDevServer(project({ 'package.json': JSON.stringify({ scripts: { build: 'x' } }) })).reason, 'no_dev_script');
});

test('reads the printed address through colour codes, and never a public one', () => {
  assert.equal(addressFromOutput('  ▲ Next.js\n  - Local:        \u001b[36mhttp://localhost:3000\u001b[0m\n'), 'http://localhost:3000/');
  assert.equal(addressFromOutput('Network: http://0.0.0.0:5173/'), 'http://localhost:5173/');
  assert.equal(addressFromOutput('see https://example.com/docs'), null);
  assert.equal(addressFromOutput('ready'), null);
});

test('only folders the person opened may run anything', () => {
  const inside = project({});
  const sub = path.join(inside, 'app');
  fs.mkdirSync(sub);
  assert.equal(allowedFolder(sub, [inside]), sub);
  assert.equal(allowedFolder(os.tmpdir(), [inside]), null);
  assert.equal(allowedFolder(inside, []), null);
  const servers = createDevServers({ getWorkspaces: () => [inside], send: () => {} });
  assert.equal(servers.start(os.tmpdir()).reason, 'folder_not_opened');
});

test('starts a real dev server, reports its address, and stops the whole process', { skip: process.platform === 'win32' }, async () => {
  const dir = project({
    'server.js': "const h=require('http');const s=h.createServer((q,r)=>r.end('hello')).listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+s.address().port));",
    'package.json': JSON.stringify({ scripts: { dev: 'node server.js' } }),
  });
  const events = [];
  const servers = createDevServers({ getWorkspaces: () => [dir], send: (event) => events.push(event) });
  assert.equal(servers.start(dir).ok, true);
  const deadline = Date.now() + 15000;
  while (!events.some((event) => event.state === 'ready') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const ready = events.find((event) => event.state === 'ready');
  assert.ok(ready, 'ready event');
  const body = await new Promise((resolve, reject) => http.get(ready.url, (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve(data)); }).on('error', reject));
  assert.equal(body, 'hello');
  assert.equal(servers.start(dir).state, 'ready', 'a second press does not start a second one');
  servers.stop(dir);
  const gone = Date.now() + 8000;
  const alive = () => new Promise((resolve) => http.get(ready.url, () => resolve(true)).on('error', () => resolve(false)));
  while (await alive() && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await alive(), false, 'server is gone after stop');
});
