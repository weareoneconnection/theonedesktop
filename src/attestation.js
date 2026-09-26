'use strict';

/**
 * This Mac's signed statement that it is the desktop computer TheOne sends
 * local work to (TheOne computer/attestation.ts verifies it).
 *
 * The key is made on first use and never leaves the data folder. TheOne
 * trusts it only after an operator adds its public key, shown in the
 * governance centre, to THEONE_COMPUTER_ATTESTATION_KEYS. The machine is the
 * person's own, so the isolation it reports is `dedicated_host`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function loadOrCreateKey(dataDir) {
  const file = path.join(dataDir, 'attestation-ed25519.pem');
  let pem = '';
  try { pem = fs.readFileSync(file, 'utf8'); } catch { /* first use */ }
  if (!pem.includes('PRIVATE KEY')) {
    pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, pem, { mode: 0o600 });
  }
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const keyId = `desktop-${createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`;
  return { privateKey, publicKey, keyId };
}

function buildAttestation({ tenantId, challenge }, { key, version, platform, arch, now = new Date() }) {
  if (!tenantId || !challenge || String(challenge).length > 512) throw new Error('tenant_and_challenge_required');
  const body = {
    schemaVersion: 'theone.computer_attestation.v1',
    provider: 'desktop',
    keyId: key.keyId,
    tenantId: String(tenantId),
    challenge: String(challenge),
    issuedAt: now.toISOString(),
    computers: [{ computerId: 'desktop-bridge', isolationProfile: 'dedicated_host', measurement: { app: version, platform, arch } }],
  };
  const digest = `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`;
  return { ...body, digest, signature: sign(null, Buffer.from(digest), key.privateKey).toString('base64url') };
}

module.exports = { buildAttestation, canonical, loadOrCreateKey };
