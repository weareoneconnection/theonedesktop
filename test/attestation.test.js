'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, verify } = require('node:crypto');
const { buildAttestation, canonical, loadOrCreateKey } = require('../src/attestation');

test('the device key is made once, kept private, and named by its public key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-attest-'));
  const first = loadOrCreateKey(dir);
  const again = loadOrCreateKey(dir);
  assert.equal(first.keyId, again.keyId);
  assert.match(first.keyId, /^desktop-[a-f0-9]{16}$/);
  assert.equal(fs.statSync(path.join(dir, 'attestation-ed25519.pem')).mode & 0o777, 0o600);
});

test('the statement is signed over its canonical digest and bound to the challenge', () => {
  const key = loadOrCreateKey(fs.mkdtempSync(path.join(os.tmpdir(), 'theone-attest-')));
  const statement = buildAttestation({ tenantId: 't1', challenge: 'att1.x' }, { key, version: '0.3.7', platform: 'darwin', arch: 'arm64' });
  const { digest, signature, ...body } = statement;
  assert.equal(digest, `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`);
  assert.equal(verify(null, Buffer.from(digest), key.publicKey, Buffer.from(signature, 'base64url')), true);
  assert.deepEqual(statement.computers.map((item) => [item.computerId, item.isolationProfile]), [['desktop-bridge', 'dedicated_host']]);
  assert.throws(() => buildAttestation({ tenantId: 't1', challenge: '' }, { key }), /tenant_and_challenge_required/);
});
