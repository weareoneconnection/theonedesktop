'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { FileError, normalizeRel, isProtected, parentOf, isUnder } = require('./paths');

const OPS = new Set(['move', 'copy', 'rename', 'mkdir', 'trash']);
const MAX_OPERATIONS = 200;
const MAX_COPY_ENTRIES = 5000;
const MAX_COPY_BYTES = 500 * 1024 * 1024;

/**
 * Turn a request into a plan, changing nothing. Every operation is checked against what the folder holds
 * now and against what the earlier operations of the same request will have done (a folder made first can be
 * moved into; a file moved first is no longer where it was). A plan with any problem cannot be applied.
 * The digest binds an approval to exactly these operations in exactly this folder.
 */

/** The operations as written, checked for shape and cleaned. */
function normalizeOperations(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new FileError('bad_request', 'There is nothing to do.');
  if (raw.length > MAX_OPERATIONS) throw new FileError('too_many', `A request can have at most ${MAX_OPERATIONS} operations.`);
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new FileError('bad_request', `Operation ${index + 1} is not an object.`);
    const op = typeof item.op === 'string' ? item.op : '';
    if (!OPS.has(op)) throw new FileError('bad_request', `Operation ${index + 1}: "${String(item.op).slice(0, 20)}" is not an operation (move, copy, rename, mkdir, trash).`);
    const wrap = (value) => { try { return normalizeRel(value); } catch (error) { throw new FileError(error.code || 'bad_path', `Operation ${index + 1}: ${error.message}`); } };
    if (op === 'mkdir') return { op, to: wrap(item.to) };
    if (op === 'trash') return { op, from: wrap(item.from) };
    return { op, from: wrap(item.from), to: wrap(item.to) };
  });
}

/**
 * @param {{ root: string, operations: unknown, platform?: string, fsx?: object }} input
 * @returns {Promise<{ ok: boolean, root: string, steps: object[], problems: object[], digest: string, counts: object }>}
 */
async function buildPlan({ root, operations, platform = process.platform, fsx = fsp }) {
  const ops = normalizeOperations(operations);
  const realRoot = await fsx.realpath(root);
  const insensitive = platform === 'win32' || platform === 'darwin';
  const key = (rel) => (insensitive ? rel.toLowerCase() : rel);
  const abs = (rel) => path.join(realRoot, ...rel.split('/'));

  // What the earlier operations of this request will have done, kept as events so any path can be resolved
  // as of any point: a path under a moved folder is the same thing under its old name, a moved-away path is gone.
  const events = [];
  const lookup = async (rel, at = events.length) => {
    const k = key(rel);
    for (let i = at - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (k === key(e.to || '\0')) return { kind: e.kind };
      if (e.from !== undefined && e.to !== undefined && isUnder(k, key(e.to))) return lookup(e.from + rel.slice(e.to.length), i);
      if ((e.type === 'move' || e.type === 'trash') && isUnder(k, key(e.from))) return null;
    }
    try {
      const stat = await fsx.lstat(abs(rel));
      return { kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file' };
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
      throw error;
    }
  };
  // Where a path really is on disk right now (null for a folder an earlier step makes and nothing fills yet).
  const diskRel = (rel, at = events.length) => {
    const k = key(rel);
    for (let i = at - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (k === key(e.to || '\0')) return e.from === undefined ? null : diskRel(e.from, i);
      if (e.from !== undefined && e.to !== undefined && isUnder(k, key(e.to))) return diskRel(e.from + rel.slice(e.to.length), i);
    }
    return rel;
  };
  // The folder a path would sit in must really be inside the opened folder once symlinks are followed.
  const containedParent = async (rel) => {
    let dir = path.dirname(abs(rel));
    for (;;) {
      try {
        const real = await fsx.realpath(dir);
        const inside = path.relative(realRoot, real);
        return inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside));
      } catch (error) {
        if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
        const up = path.dirname(dir);
        if (up === dir) return false;
        dir = up;
      }
    }
  };
  const scanForCopy = async (rel) => {
    const real = diskRel(rel);
    if (real === null) return { entries: 1, bytes: 0 };
    let entries = 0; let bytes = 0;
    const walk = async (dirRel) => {
      for (const name of await fsx.readdir(abs(dirRel))) {
        const childRel = `${dirRel}/${name}`;
        const stat = await fsx.lstat(abs(childRel));
        if (stat.isSymbolicLink()) throw new FileError('symlink', `${childRel} is a link; links are not copied.`);
        entries += 1;
        if (entries > MAX_COPY_ENTRIES) throw new FileError('too_big', `That copy holds more than ${MAX_COPY_ENTRIES} items.`);
        if (stat.isDirectory()) await walk(childRel); else bytes += stat.size;
        if (bytes > MAX_COPY_BYTES) throw new FileError('too_big', 'That copy is larger than 500 MB.');
      }
    };
    const first = await fsx.lstat(abs(real));
    if (first.isSymbolicLink()) throw new FileError('symlink', 'A link cannot be copied.');
    if (first.isDirectory()) await walk(real); else bytes = first.size;
    return { entries: entries + 1, bytes };
  };

  const steps = [];
  const problems = [];
  const reject = (index, code, message) => problems.push({ index, code, message });

  for (let index = 0; index < ops.length; index += 1) {
    const step = ops[index];
    const { op, from, to } = step;
    try {
      for (const rel of [from, to].filter(Boolean)) if (isProtected(rel)) throw new FileError('protected', `${rel} is inside .git, which is never touched.`);
      for (const rel of [from, to].filter(Boolean)) if (!(await containedParent(rel))) throw new FileError('outside', `${rel} would be outside the folder.`);
      let kind;
      let detail = {};
      if (from !== undefined) {
        const source = await lookup(from);
        if (!source) throw new FileError('missing', `${from} does not exist.`);
        kind = source.kind;
        if (op === 'copy') detail = await scanForCopy(from);
      }
      if (to !== undefined) {
        const target = await lookup(to);
        const caseOnly = from !== undefined && insensitive && key(from) === key(to) && from !== to;
        if (target && !caseOnly) throw new FileError('exists', `${to} already exists; nothing is overwritten.`);
        const parent = parentOf(to);
        if (parent) {
          const holder = await lookup(parent);
          if (!holder || holder.kind !== 'dir') throw new FileError('no_parent', `The folder ${parent} does not exist.`);
        }
        if (from !== undefined && isUnder(key(to), key(from)) && key(to) !== key(from)) throw new FileError('into_itself', `${from} cannot be moved or copied into itself.`);
        if (op === 'rename' && parentOf(from) !== parentOf(to)) throw new FileError('bad_request', 'A rename keeps the file in its folder; use move to change folders.');
        if (op === 'move' && key(from) === key(to)) throw new FileError('bad_request', `${from} is already there.`);
      }
      events.push(op === 'mkdir' ? { type: 'mkdir', to, kind: 'dir' } : op === 'trash' ? { type: 'trash', from, kind } : { type: op === 'copy' ? 'copy' : 'move', from, to, kind });
      steps.push({ index, op, from, to, kind, ...detail });
    } catch (error) {
      if (error instanceof FileError) reject(index, error.code, error.message);
      else throw error;
    }
  }

  const digest = crypto.createHash('sha256').update(JSON.stringify({ root: realRoot, ops })).digest('hex');
  const counts = { operations: ops.length, trash: ops.filter((item) => item.op === 'trash').length };
  return { ok: problems.length === 0, root: realRoot, steps, problems, digest, counts, operations: ops };
}

module.exports = { buildPlan, normalizeOperations, OPS, MAX_OPERATIONS };
