'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { buildPlan } = require('./plan');
const { FileError } = require('./paths');

/**
 * Do an approved plan, and undo it.
 *
 * The plan is made again right before anything happens and must give the digest the person approved: the
 * folder may have changed since the preview, and an approval is for exactly those operations. Everything
 * but the trash goes first and in order; if one step fails, the steps already done are taken back in reverse,
 * so a failed request leaves the folder as it was. The trash goes last, because a file in the system trash
 * cannot be put back from here.
 */

const abs = (root, rel) => path.join(root, ...rel.split('/'));

async function doStep(step, { root, fsx, trashItem }) {
  if (step.op === 'mkdir') await fsx.mkdir(abs(root, step.to));
  else if (step.op === 'move' || step.op === 'rename') await fsx.rename(abs(root, step.from), abs(root, step.to));
  else if (step.op === 'copy') await fsx.cp(abs(root, step.from), abs(root, step.to), { recursive: true, errorOnExist: true, force: false, dereference: false });
  else if (step.op === 'trash') await trashItem(abs(root, step.from));
  else throw new FileError('bad_request', `Cannot do "${step.op}".`);
}

/** Take back one done step. Throws if what it finds is not what the step left, rather than guess. */
async function undoStep(step, { root, fsx }) {
  if (step.op === 'mkdir') {
    await fsx.rmdir(abs(root, step.to));
  } else if (step.op === 'move' || step.op === 'rename') {
    let free = false;
    try { await fsx.lstat(abs(root, step.from)); } catch (error) { free = error && error.code === 'ENOENT'; }
    if (!free) throw new FileError('conflict', `${step.from} is taken now, so ${step.to} was not moved back.`);
    await fsx.rename(abs(root, step.to), abs(root, step.from));
  } else if (step.op === 'copy') {
    // Only the copy this step made.
    if (!step.to) throw new FileError('bad_request', 'No copy to remove.');
    await fsx.rm(abs(root, step.to), { recursive: true, force: false });
  } else {
    throw new FileError('not_undoable', `${step.from} went to the trash; restore it from there.`);
  }
}

/**
 * @returns {Promise<{ status: 'applied'|'refused'|'rolled_back'|'partial', id?: string, plan: object, done: object[], error?: object }>}
 */
async function applyPlan({ root, operations, approvalDigest, journal, trashItem, platform = process.platform, fsx = fsp, now = () => Date.now() }) {
  const plan = await buildPlan({ root, operations, platform, fsx });
  if (!plan.ok) return { status: 'refused', plan, done: [], error: { code: 'plan_problems', message: plan.problems[0].message } };
  if (typeof approvalDigest !== 'string' || approvalDigest !== plan.digest) {
    return { status: 'refused', plan, done: [], error: { code: 'not_approved', message: 'This is not what was approved: the operations or the folder changed since the preview. Look at the plan again.' } };
  }
  const ordered = [...plan.steps.filter((step) => step.op !== 'trash'), ...plan.steps.filter((step) => step.op === 'trash')];
  const done = [];
  let failure = null;
  for (const step of ordered) {
    try {
      await doStep(step, { root: plan.root, fsx, trashItem });
      done.push(step);
    } catch (error) {
      failure = { code: (error && error.code) || 'failed', message: `${step.op} ${step.from || ''}${step.to ? ` → ${step.to}` : ''}: ${(error && error.message) || String(error)}`.slice(0, 300), step };
      break;
    }
  }
  const id = crypto.randomBytes(6).toString('hex');
  if (!failure) {
    if (journal) journal.add({ id, at: now(), root: plan.root, status: 'applied', steps: done.map(({ op, from, to, kind }) => ({ op, from, to, kind })) });
    return { status: 'applied', id, plan, done };
  }
  // Take back what was done, newest first. A trashed item cannot be, and then the request stands as partial.
  const stuck = [];
  for (const step of [...done].reverse()) {
    try { await undoStep(step, { root: plan.root, fsx }); } catch (error) { stuck.push({ step, message: (error && error.message) || String(error) }); }
  }
  const status = stuck.length ? 'partial' : 'rolled_back';
  if (journal && (stuck.length || done.length)) journal.add({ id, at: now(), root: plan.root, status, steps: stuck.map(({ step }) => ({ op: step.op, from: step.from, to: step.to, kind: step.kind })), error: failure.message });
  return { status, id, plan, done: stuck.map((item) => item.step), error: failure, stuck };
}

/** Undo an applied request by its id: everything but the trash, newest first. */
async function undoRequest({ id, journal, fsx = fsp, now = () => Date.now() }) {
  const entry = journal.get(id);
  if (!entry) throw new FileError('unknown', 'There is no such request to undo.');
  if (entry.status !== 'applied') throw new FileError('not_undoable', 'Only a request that was fully applied can be undone.');
  if (entry.undoneAt) throw new FileError('already', 'That request was already undone.');
  const undone = [];
  const notUndone = [];
  for (const step of [...entry.steps].reverse()) {
    if (step.op === 'trash') { notUndone.push(step); continue; }
    try { await undoStep(step, { root: entry.root, fsx }); undone.push(step); } catch (error) { notUndone.push({ ...step, reason: (error && error.message) || String(error) }); }
  }
  if (undone.length) journal.add({ id, undoneAt: now(), undone: undone.length, notUndone: notUndone.length });
  return { undone, notUndone };
}

/** The requests made, newest first, one line per request; a later line for the same id (undone) updates it. */
class FileJournal {
  constructor(file) { this.file = file; }

  add(entry) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  list(limit = 50) {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const byId = new Map();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry.id !== 'string') continue;
      byId.set(entry.id, { ...(byId.get(entry.id) || {}), ...entry });
    }
    return [...byId.values()].filter((entry) => entry.at).sort((a, b) => b.at - a.at).slice(0, limit);
  }

  get(id) { return this.list(500).find((entry) => entry.id === id) || null; }
}

module.exports = { applyPlan, undoRequest, FileJournal };
