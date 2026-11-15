'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  BRIDGE_SCHEMA_VERSION,
  SUPPORTED_CAPABILITIES,
  TASK_RESULT_VERSIONS,
  bridgeContract,
} = require('../src/bridge-contract');

test('bridge v2 advertises stable capabilities instead of app-version guesses', () => {
  const contract = bridgeContract({ schemaVersion: 'theone.desktop_runtime_provenance.v1', integrity: 'verified' });
  assert.equal(contract.schemaVersion, BRIDGE_SCHEMA_VERSION);
  assert.deepEqual([contract.minimumProtocolVersion, contract.protocolVersion, contract.maximumProtocolVersion], [1, 2, 2]);
  assert.deepEqual(contract.capabilities, [...SUPPORTED_CAPABILITIES]);
  assert.equal(contract.capabilities.includes('signedTaskReceiptV1'), true);
  assert.equal(contract.capabilities.includes('taskIndexV1'), true);
  assert.equal(contract.capabilities.includes('runtimeProvenanceV2'), false);
  assert.deepEqual(contract.taskResultVersions, [...TASK_RESULT_VERSIONS]);
  assert.deepEqual(contract.bundledRuntime, {
    provenanceSchemaVersion: 'theone.desktop_runtime_provenance.v1',
    integrity: 'verified',
    taskResultVersions: ['theone.code_execution_result.v2'],
  });
});

test('bridge contract reports an unavailable runtime schema without inventing support', () => {
  assert.equal(bridgeContract(null).bundledRuntime.provenanceSchemaVersion, null);
  assert.equal(bridgeContract(null).bundledRuntime.integrity, null);
});

test('runtime provenance v2 capability is advertised only after full artifact verification', () => {
  assert.equal(bridgeContract({ schemaVersion: 'theone.desktop_runtime_provenance.v2', integrity: 'mismatch' }).capabilities.includes('runtimeProvenanceV2'), false);
  assert.equal(bridgeContract({ schemaVersion: 'theone.desktop_runtime_provenance.v2', integrity: 'verified' }).capabilities.includes('runtimeProvenanceV2'), true);
});

test('signed-receipt capability disappears when the device key is unavailable', () => {
  assert.equal(bridgeContract(null, { signingAvailable: false }).capabilities.includes('signedTaskReceiptV1'), false);
});
