'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('approving a local task asks OneClaw to dispatch in the background', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /v1\/approvals\/.*\/approve[\s\S]*x-oneclaw-dispatch[\s\S]*background/);
});

test('a delivery is dispatched as its own action and its approval is recorded as the person\'s request', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /body\.deliver === true[\s\S]*action: 'code\.workspace\.deliver'[\s\S]*approvalMode: 'manual'[\s\S]*approveWhenAsked\(String\(id\), 'theone-desktop: the person asked to commit and push'\)/);
});
