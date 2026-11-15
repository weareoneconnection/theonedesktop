'use strict';

const { createHash, sign, verify } = require('node:crypto');
const { canonical } = require('./attestation');

const TASK_RECEIPT_SCHEMA = 'theone.local_task_receipt.v1';
const TASK_RESULT_SCHEMA = 'theone.code_execution_result.v2';

const text = (value, limit) => String(value || '').trim().slice(0, limit);
const nullableText = (value, limit) => {
  const result = text(value, limit);
  return result || null;
};
const booleanOrNull = (value) => (typeof value === 'boolean' ? value : null);
const digestOrNull = (value) => (/^sha256:[a-f0-9]{64}$/.test(String(value || '')) ? String(value) : null);
const safeBinding = (value) => (/^[A-Za-z0-9_-]{40,60}$/.test(String(value || '')) ? String(value) : '');
const safeSession = (value) => (/^[A-Za-z0-9_:-]{6,120}$/.test(String(value || '')) ? String(value) : null);
const safeThread = (value) => (/^[A-Za-z0-9_:-]{6,80}$/.test(String(value || '')) ? String(value) : null);

function digestCanonical(value) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function terminalOutput(task) {
  const steps = Array.isArray(task && task.steps) ? task.steps : [];
  const step = [...steps].reverse().find((candidate) => candidate && candidate.output && typeof candidate.output === 'object');
  return step ? step.output : {};
}

function changedFiles(value) {
  const paths = (Array.isArray(value) ? value : []).flatMap((item) => {
    const path = typeof item === 'string' ? item : item && typeof item === 'object' ? item.path : '';
    const clean = text(path, 500);
    return clean ? [clean] : [];
  });
  return [...new Set(paths)].sort().slice(0, 200);
}

/**
 * The structured facts the Desktop main process is willing to attest. Text
 * summaries, logs, commands and arbitrary Provider responses never enter the
 * signed envelope.
 */
function taskReceiptEvidence({ task, identityBinding, sessionId, threadId }) {
  if (!task || typeof task !== 'object') throw new Error('task receipt requires a compact task');
  const taskId = text(task.id, 80);
  if (!/^local:[A-Za-z0-9_-]{4,64}$/.test(taskId)) throw new Error('invalid local task receipt id');
  const binding = safeBinding(identityBinding);
  if (!binding) throw new Error('invalid task receipt identity binding');
  const output = terminalOutput(task);
  const lifecycleStatus = text(output.lifecycleStatus || output.status || task.status || 'unknown', 80) || 'unknown';
  const assurance = output.acceptanceAssurance === 'runtime_checks' || output.acceptanceAssurance === 'independent'
    ? output.acceptanceAssurance
    : null;
  const writeback = output.trustedStagingWriteback && typeof output.trustedStagingWriteback === 'object'
    ? { applied: output.trustedStagingWriteback.applied === true }
    : null;
  const sourceUpdatedAt = nullableText(task.updatedAt || task.completedAt || task.startedAt || task.createdAt, 40);
  return {
    schemaVersion: TASK_RECEIPT_SCHEMA,
    provider: 'desktop',
    identityBinding: binding,
    sessionId: safeSession(sessionId),
    taskId,
    workUnitId: nullableText(output.workUnitId, 200),
    threadId: safeThread(threadId || task.threadId),
    rawStatus: text(task.status || 'unknown', 40) || 'unknown',
    lifecycleStatus,
    verification: {
      verified: booleanOrNull(output.verified),
      verifyPassed: booleanOrNull(output.verifyPassed),
      acceptancePassed: booleanOrNull(output.acceptancePassed),
      acceptanceAssurance: assurance,
    },
    failure: {
      failureClass: nullableText(output.failureClass, 80),
      retryable: booleanOrNull(output.retryable),
      nextAction: nullableText(output.nextAction, 120),
    },
    resultDigest: digestOrNull(output.resultDigest),
    diffDigest: digestOrNull(output.diffDigest),
    changedFiles: changedFiles(output.changedFiles),
    trustedStagingWriteback: writeback,
    taskResultSchemaVersion: output.schemaVersion === TASK_RESULT_SCHEMA ? TASK_RESULT_SCHEMA : null,
    sourceUpdatedAt,
  };
}

function taskReceiptStateDigest(input) {
  return digestCanonical(taskReceiptEvidence(input));
}

function buildTaskReceipt({ task, identityBinding, sessionId, threadId, sequence, issuedAt }, { key }) {
  if (!key || !key.privateKey || !/^desktop-[a-f0-9]{16}$/.test(String(key.keyId || ''))) {
    throw new Error('task receipt signing key is unavailable');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('task receipt sequence must be positive');
  const issued = String(issuedAt || '');
  if (!Number.isFinite(Date.parse(issued))) throw new Error('task receipt issuedAt is invalid');
  const body = {
    ...taskReceiptEvidence({ task, identityBinding, sessionId, threadId }),
    keyId: key.keyId,
    sequence,
    issuedAt: issued,
  };
  const digest = digestCanonical(body);
  return { ...body, digest, signature: sign(null, Buffer.from(digest), key.privateKey).toString('base64url') };
}

function verifyTaskReceipt(receipt, publicKey) {
  if (!receipt || typeof receipt !== 'object') return false;
  const { digest, signature, ...body } = receipt;
  if (digestCanonical(body) !== digest || !String(signature || '')) return false;
  try {
    return verify(null, Buffer.from(digest), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

module.exports = {
  TASK_RECEIPT_SCHEMA,
  TASK_RESULT_SCHEMA,
  buildTaskReceipt,
  digestCanonical,
  taskReceiptEvidence,
  taskReceiptStateDigest,
  verifyTaskReceipt,
};
