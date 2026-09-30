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
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.version === 1 && parsed.owners && typeof parsed.owners === 'object') owners = parsed.owners;
  } catch { /* first run or a corrupt optional index: old tasks stay quarantined */ }

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, owners }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };

  return {
    claim(taskId, identity) {
      const id = String(taskId || '');
      if (!id) throw new Error('invalid task id');
      owners[id] = identityKey(identity);
      save();
    },
    owns(taskId, identity) {
      return Boolean(owners[String(taskId || '')]) && owners[String(taskId || '')] === identityKey(identity);
    },
    assertOwns(taskId, identity) {
      if (!this.owns(taskId, identity)) throw new Error('This local task does not belong to the signed-in account.');
    },
  };
}

module.exports = { createTaskOwnershipStore, identityKey };
