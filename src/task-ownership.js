'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** A stable, non-reversible account namespace for local task ownership. */
function identityKey(identity) {
  const tenantId = String(identity && identity.tenantId || '').trim();
  const userId = String(identity && identity.userId || '').trim();
  if (!tenantId || !userId || tenantId.length > 200 || userId.length > 200) throw new Error('A signed-in account is required for local tasks.');
  return crypto.createHash('sha256').update(`${tenantId}\0${userId}`).digest('base64url');
}

function createTaskOwnershipStore(dataDir) {
  const file = path.join(dataDir, 'task-owners.json');
  let owners = {};
  let tasks = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && (parsed.version === 1 || parsed.version === 2) && parsed.owners && typeof parsed.owners === 'object') {
      owners = parsed.owners;
      if (parsed.version === 2 && parsed.tasks && typeof parsed.tasks === 'object') tasks = parsed.tasks;
    }
  } catch { /* first run or a corrupt optional index: old tasks stay quarantined */ }

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 2, owners, tasks }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };

  const cleanThreadId = (value) => {
    const threadId = String(value || '').trim();
    return /^[A-Za-z0-9_:-]{6,80}$/.test(threadId) ? threadId : null;
  };
  const cleanSessionId = (value) => {
    const sessionId = String(value || '').trim();
    return /^[A-Za-z0-9_:-]{6,120}$/.test(sessionId) ? sessionId : null;
  };
  const cleanTime = (value) => {
    const text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}T/.test(text) && Number.isFinite(Date.parse(text)) ? text.slice(0, 40) : null;
  };
  const entryFor = (taskId, identity) => {
    const id = String(taskId || '');
    const owner = identityKey(identity);
    if (!id || owners[id] !== owner) throw new Error('This local task does not belong to the signed-in account.');
    const existing = tasks[id] && tasks[id].owner === owner;
    const current = existing ? tasks[id] : { owner, sequence: 0 };
    tasks[id] = current;
    return { id, owner, current, created: !existing };
  };

  return {
    claim(taskId, identity, metadata = {}) {
      const id = String(taskId || '');
      if (!id) throw new Error('invalid task id');
      const owner = identityKey(identity);
      if (owners[id] && owners[id] !== owner) throw new Error('This local task is already bound to another signed-in account.');
      owners[id] = owner;
      const previous = tasks[id] && tasks[id].owner === owner ? tasks[id] : {};
      tasks[id] = {
        ...previous,
        owner,
        sequence: Number.isSafeInteger(previous.sequence) && previous.sequence >= 0 ? previous.sequence : 0,
        ...(cleanThreadId(metadata.threadId) ? { threadId: cleanThreadId(metadata.threadId) } : {}),
        ...(cleanSessionId(metadata.sessionId) ? { sessionId: cleanSessionId(metadata.sessionId) } : {}),
        ...(cleanTime(metadata.createdAt) ? { createdAt: cleanTime(metadata.createdAt) } : {}),
        ...(cleanTime(metadata.updatedAt) ? { updatedAt: cleanTime(metadata.updatedAt) } : {}),
      };
      save();
    },
    owns(taskId, identity) {
      return Boolean(owners[String(taskId || '')]) && owners[String(taskId || '')] === identityKey(identity);
    },
    assertOwns(taskId, identity) {
      if (!this.owns(taskId, identity)) throw new Error('This local task does not belong to the signed-in account.');
    },
    /** Refresh the durable, account-scoped task index without weakening ownership. */
    record(taskId, identity, metadata = {}) {
      const { current, created } = entryFor(taskId, identity);
      const threadId = cleanThreadId(metadata.threadId);
      const sessionId = cleanSessionId(metadata.sessionId);
      const createdAt = cleanTime(metadata.createdAt);
      const updatedAt = cleanTime(metadata.updatedAt);
      let changed = created;
      if (threadId && !current.threadId) { current.threadId = threadId; changed = true; }
      // A task's server session binding is immutable after dispatch. A later
      // renderer may be looking at another conversation while polling it.
      if (sessionId && !current.sessionId) { current.sessionId = sessionId; changed = true; }
      if (createdAt && current.createdAt !== createdAt) { current.createdAt = createdAt; changed = true; }
      if (updatedAt && current.updatedAt !== updatedAt) { current.updatedAt = updatedAt; changed = true; }
      if (changed) save();
      return { ...current };
    },
    metadata(taskId, identity) {
      const { current } = entryFor(taskId, identity);
      return { ...current };
    },
    list(identity, { threadId } = {}) {
      const owner = identityKey(identity);
      const requestedThread = cleanThreadId(threadId);
      return Object.entries(owners)
        .filter(([, value]) => value === owner)
        .map(([taskId]) => ({ taskId, ...(tasks[taskId] && tasks[taskId].owner === owner ? tasks[taskId] : { owner }) }))
        .filter((item) => !requestedThread || item.threadId === requestedThread)
        .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')) || b.taskId.localeCompare(a.taskId));
    },
    /**
     * Allocate a monotonic sequence only when signed task state changes. The
     * same state gets the same sequence and issuedAt across repeated polls.
     */
    receiptSequence(taskId, identity, stateDigest, now = new Date()) {
      const digest = String(stateDigest || '');
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('invalid task receipt state digest');
      const { current } = entryFor(taskId, identity);
      if (current.stateDigest === digest && Number.isSafeInteger(current.sequence) && current.sequence > 0 && cleanTime(current.issuedAt)) {
        return { sequence: current.sequence, issuedAt: current.issuedAt };
      }
      current.sequence = (Number.isSafeInteger(current.sequence) && current.sequence >= 0 ? current.sequence : 0) + 1;
      current.stateDigest = digest;
      current.issuedAt = now.toISOString();
      save();
      return { sequence: current.sequence, issuedAt: current.issuedAt };
    },
  };
}

module.exports = { createTaskOwnershipStore, identityKey };
