'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clampBounds, loopbackUrl, previewTarget } = require('../src/preview-policy');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-policy-'));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(project, 'dist'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(project, 'dist', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(project, 'secrets.env'), 'KEY=1');
  fs.writeFileSync(path.join(project, 'run.js'), 'x');
  fs.writeFileSync(path.join(outside, 'private.html'), '<h1>private</h1>');
  fs.symlinkSync(path.join(outside, 'private.html'), path.join(project, 'link.html'));
  fs.symlinkSync(outside, path.join(project, 'linked-dir'));
  return { root, project, outside };
}

test('what a person types becomes a loopback address, and nothing else does', () => {
  assert.equal(loopbackUrl('3000'), 'http://localhost:3000/');
  assert.equal(loopbackUrl(':5173'), 'http://localhost:5173/');
  assert.equal(loopbackUrl('localhost:8080/app'), 'http://localhost:8080/app');
  assert.equal(loopbackUrl('http://0.0.0.0:3000'), 'http://localhost:3000/');
  assert.equal(loopbackUrl('http://[::1]:3000'), 'http://[::1]:3000/');
  for (const bad of ['', 'https://example.com', 'http://169.254.169.254', 'http://10.0.0.5', 'http://localhost.evil.com', 'http://user:pw@localhost', 'ftp://localhost', 'javascript:alert(1)', 'data:text/html,hi']) {
    assert.equal(loopbackUrl(bad), null, bad);
  }
});

test('a file opens only from inside an opened folder, and only if it is a page, image or PDF', () => {
  const { project, outside } = fixture();
  const ok = previewTarget(path.join(project, 'index.html'), [project]);
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, 'file');
  assert.match(ok.url, /^file:\/\/.*index\.html$/);
  assert.equal(previewTarget(ok.url, [project]).ok, true);
  assert.equal(previewTarget(path.join(project, 'dist', 'logo.svg'), [project]).ok, true);

  for (const bad of [path.join(outside, 'private.html'), path.join(project, 'secrets.env'), path.join(project, 'run.js'), path.join(project, 'missing.html'), '/etc/passwd', project]) {
    assert.equal(previewTarget(bad, [project]).ok, false, bad);
  }
  assert.equal(previewTarget(path.join(project, 'index.html'), []).ok, false);
});

test('a link inside the folder cannot lead out of it', () => {
  const { project } = fixture();
  assert.equal(previewTarget(path.join(project, 'link.html'), [project]).ok, false);
  assert.equal(previewTarget(path.join(project, 'linked-dir', 'private.html'), [project]).ok, false);
});

test('a relative path or a bare name is not a file target', () => {
  const { project } = fixture();
  assert.deepEqual(previewTarget('index.html', [project]), { ok: false, reason: 'not_local' });
  assert.equal(previewTarget('../outside/private.html', [project]).ok, false);
});

test('bounds are whole numbers kept inside the window, and follow the zoom', () => {
  assert.deepEqual(clampBounds({ x: 10.4, y: 20.6, width: 300.2, height: 200.7 }, { width: 1000, height: 800 }), { x: 10, y: 21, width: 300, height: 201 });
  assert.deepEqual(clampBounds({ x: 900, y: 700, width: 500, height: 500 }, { width: 1000, height: 800 }), { x: 900, y: 700, width: 100, height: 100 });
  assert.deepEqual(clampBounds({ x: -5, y: -5, width: -1, height: 'x' }, { width: 1000, height: 800 }), { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(clampBounds({ x: 10, y: 10, width: 100, height: 100 }, { width: 1000, height: 800 }, 1.5), { x: 15, y: 15, width: 150, height: 150 });
});
