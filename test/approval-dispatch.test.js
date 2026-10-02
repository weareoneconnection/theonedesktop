'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('approving a local task asks OneClaw to dispatch in the background', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /v1\/approvals\/.*\/approve[\s\S]*x-oneclaw-dispatch[\s\S]*background/);
});
