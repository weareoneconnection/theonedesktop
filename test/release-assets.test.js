'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('release verification requires updater metadata and downloadable artifacts', async () => {
  const { expectedReleaseAssets, missingReleaseAssets } = await import('../scripts/verify-release-assets.mjs');
  const mac = expectedReleaseAssets('0.4.38', 'mac');
  assert.deepEqual(mac, [
    'TheOne-0.4.38-arm64.dmg',
    'TheOne-0.4.38-arm64.dmg.blockmap',
    'TheOne-0.4.38-arm64-mac.zip',
    'TheOne-0.4.38-arm64-mac.zip.blockmap',
    'latest-mac.yml',
  ]);
  assert.deepEqual(
    missingReleaseAssets(['TheOne-0.4.38-arm64.dmg'], '0.4.38', 'mac'),
    mac.slice(1),
  );
  assert.deepEqual(missingReleaseAssets(expectedReleaseAssets('0.4.38'), '0.4.38'), []);
});
