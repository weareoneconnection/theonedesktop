'use strict';

/**
 * Stable contract advertised to independently deployed TheOne web clients.
 * Feature checks use capability ids rather than the Desktop app version.
 */
const BRIDGE_SCHEMA_VERSION = 'theone.desktop_bridge.v2';
const BRIDGE_PROTOCOL = Object.freeze({ current: 2, minimum: 1, maximum: 2 });
const TASK_RESULT_VERSIONS = Object.freeze(['theone.code_execution_result.v2']);
const KNOWN_CAPABILITIES = Object.freeze([
  'identityIsolationV1',
  'signedTaskReceiptV1',
  'taskIndexV1',
  'typedFailureV2',
  'recoveryManifestV1',
  'logCursorV1',
  'runtimeProvenanceV1',
  'runtimeProvenanceV2',
  'terminalV1',
  'mcpV1',
  'filesV1',
  // Known, not yet advertised: it is only turned on once a window capture has been verified on a real Mac.
  'computerReadV1',
]);
const SUPPORTED_CAPABILITIES = Object.freeze([
  'identityIsolationV1',
  'signedTaskReceiptV1',
  'taskIndexV1',
  'typedFailureV2',
  'logCursorV1',
  'runtimeProvenanceV1',
  'terminalV1',
  'mcpV1',
  'filesV1',
]);

function bridgeContract(provenance, { signingAvailable = true, computerCapture = false } = {}) {
  const runtimeSchemaVersion = provenance && typeof provenance.schemaVersion === 'string'
    ? provenance.schemaVersion
    : null;
  const runtimeV2Verified = runtimeSchemaVersion === 'theone.desktop_runtime_provenance.v2'
    && provenance.integrity === 'verified';
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    protocolVersion: BRIDGE_PROTOCOL.current,
    minimumProtocolVersion: BRIDGE_PROTOCOL.minimum,
    maximumProtocolVersion: BRIDGE_PROTOCOL.maximum,
    capabilities: [
      ...SUPPORTED_CAPABILITIES.filter((capability) => capability !== 'signedTaskReceiptV1' || signingAvailable),
      // Only where a window capture exists on this system (computer/provider.js).
      ...(computerCapture ? ['computerReadV1'] : []),
      ...(runtimeV2Verified ? ['runtimeProvenanceV2'] : []),
    ],
    knownCapabilities: [...KNOWN_CAPABILITIES],
    taskResultVersions: [...TASK_RESULT_VERSIONS],
    bundledRuntime: {
      provenanceSchemaVersion: runtimeSchemaVersion,
      integrity: provenance && ['verified', 'mismatch', 'unavailable'].includes(provenance.integrity)
        ? provenance.integrity
        : null,
      taskResultVersions: [...TASK_RESULT_VERSIONS],
    },
  };
}

module.exports = {
  BRIDGE_PROTOCOL,
  BRIDGE_SCHEMA_VERSION,
  KNOWN_CAPABILITIES,
  SUPPORTED_CAPABILITIES,
  TASK_RESULT_VERSIONS,
  bridgeContract,
};
