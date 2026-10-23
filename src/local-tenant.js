'use strict';

/**
 * The tenant the local runtime serves: this computer's one person.
 *
 * The runtime refuses to create a task for no tenant (TENANT_PRINCIPAL_REQUIRED)
 * since it learned to serve several on one server; the app owns who may see a
 * local task (task-ownership.js), so the runtime is simply told it serves one
 * tenant. Tasks saved by versions before that carry no tenant and would vanish
 * from the history, so they are given this one before the runtime reads them.
 */

const fs = require('node:fs');

const LOCAL_TENANT = 'local';

/** Gives every saved task without a tenant the local one. Returns how many changed. */
function adoptLocalTasks(file, tenantId = LOCAL_TENANT) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0; // no history yet, or unreadable: the runtime handles both
  }
  const tasks = Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks : [];
  let changed = 0;
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
    if (metadata.tenantId) continue;
    task.metadata = { ...metadata, tenantId };
    changed += 1;
  }
  if (!changed) return 0;
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
  fs.renameSync(temp, file);
  return changed;
}

module.exports = { LOCAL_TENANT, adoptLocalTasks };
