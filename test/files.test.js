'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeRel, isProtected, FileError } = require('../src/files/paths');
const { buildPlan, normalizeOperations } = require('../src/files/plan');
const { applyPlan, undoRequest, FileJournal } = require('../src/files/apply');

function folder(files = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-test-')));
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content === null) fs.mkdirSync(file, { recursive: true }); else fs.writeFileSync(file, content);
  }
  return { base, root, journal: new FileJournal(path.join(base, 'journal.jsonl')), trashed: [], trashItem: async function trash(p) { this.trashed.push(p); await fsp.rm(p, { recursive: true }); } };
}
const run = (t, operations, extra = {}) => buildPlan({ root: t.root, operations, ...extra });
const apply = async (t, operations, extra = {}) => {
  const plan = await run(t, operations);
  return applyPlan({ root: t.root, operations, approvalDigest: plan.digest, journal: t.journal, trashItem: (p) => t.trashItem.call(t, p), ...extra });
};
const exists = (t, rel) => fs.existsSync(path.join(t.root, rel));

// ------------------------------------------------------------------- names ---

test('a path is relative, forward-slashed and made of ordinary names', () => {
  assert.equal(normalizeRel('a/b.txt'), 'a/b.txt');
  assert.equal(normalizeRel('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(normalizeRel('dir/'), 'dir');
  for (const bad of ['', '   ', '/etc/passwd', 'C:\\x', '../x', 'a/../b', 'a//b', './a', 'a/./b', 'a\u0000b', 'a:b', 'a?b', 'nul', 'CON.txt', 'dir/aux', 'ends. ', 'x'.repeat(256), 'a/'.repeat(600), 5, null, {}]) {
    assert.throws(() => normalizeRel(bad), (error) => error instanceof FileError, String(bad).slice(0, 20));
  }
  assert.equal(isProtected('a/.git/config'), true);
  assert.equal(isProtected('.GIT'), true);
  assert.equal(isProtected('a/.github/x'), false);
});

test('a request has to be a list of well-formed operations, and not too long', () => {
  assert.throws(() => normalizeOperations([]), /nothing to do/);
  assert.throws(() => normalizeOperations('move'), FileError);
  assert.throws(() => normalizeOperations([{ op: 'delete', from: 'a' }]), /not an operation/);
  assert.throws(() => normalizeOperations([{ op: 'move', from: 'a' }]), FileError);
  assert.throws(() => normalizeOperations(Array.from({ length: 201 }, () => ({ op: 'mkdir', to: 'a' }))), /at most 200/);
  assert.deepEqual(normalizeOperations([{ op: 'trash', from: 'x', extra: 1 }]), [{ op: 'trash', from: 'x' }]);
});

// -------------------------------------------------------------------- plans ---

test('a plan of good operations has no problems, a digest, and changes nothing', async () => {
  const t = folder({ 'a.txt': 'A', 'sub/b.txt': 'B' });
  const plan = await run(t, [{ op: 'move', from: 'a.txt', to: 'sub/a.txt' }, { op: 'copy', from: 'sub/b.txt', to: 'b-copy.txt' }, { op: 'mkdir', to: 'new' }, { op: 'rename', from: 'sub', to: 'sub2' }]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps.map((step) => step.op), ['move', 'copy', 'mkdir', 'rename']);
  assert.match(plan.digest, /^[0-9a-f]{64}$/);
  assert.ok(exists(t, 'a.txt') && !exists(t, 'sub/a.txt') && !exists(t, 'new'));
});

test('the digest is for exactly these operations in this folder', async () => {
  const t = folder({ 'a.txt': 'A' });
  const one = await run(t, [{ op: 'move', from: 'a.txt', to: 'b.txt' }]);
  assert.equal(one.digest, (await run(t, [{ op: 'move', from: 'a.txt', to: 'b.txt' }])).digest);
  assert.notEqual(one.digest, (await run(t, [{ op: 'move', from: 'a.txt', to: 'c.txt' }])).digest);
  assert.notEqual(one.digest, (await run(folder({ 'a.txt': 'A' }), [{ op: 'move', from: 'a.txt', to: 'b.txt' }])).digest);
});

test('nothing is overwritten, nothing missing is moved, nothing goes into itself', async () => {
  const t = folder({ 'a.txt': 'A', 'b.txt': 'B', 'd/x.txt': 'X' });
  const codes = async (operation) => (await run(t, [operation])).problems.map((problem) => problem.code);
  assert.deepEqual(await codes({ op: 'move', from: 'a.txt', to: 'b.txt' }), ['exists']);
  assert.deepEqual(await codes({ op: 'copy', from: 'a.txt', to: 'b.txt' }), ['exists']);
  assert.deepEqual(await codes({ op: 'mkdir', to: 'd' }), ['exists']);
  assert.deepEqual(await codes({ op: 'move', from: 'nope.txt', to: 'c.txt' }), ['missing']);
  assert.deepEqual(await codes({ op: 'trash', from: 'nope.txt' }), ['missing']);
  assert.deepEqual(await codes({ op: 'move', from: 'd', to: 'd/inner' }), ['into_itself']);
  assert.deepEqual(await codes({ op: 'copy', from: 'd', to: 'd/inner' }), ['into_itself']);
  assert.deepEqual(await codes({ op: 'move', from: 'a.txt', to: 'a.txt' }), ['exists']);
  assert.deepEqual(await codes({ op: 'move', from: 'a.txt', to: 'nodir/a.txt' }), ['no_parent']);
  assert.deepEqual(await codes({ op: 'rename', from: 'd/x.txt', to: 'y.txt' }), ['bad_request']);
});

test('.git is never touched', async () => {
  const t = folder({ '.git/config': 'c', 'a.txt': 'A' });
  for (const operation of [{ op: 'trash', from: '.git' }, { op: 'move', from: '.git/config', to: 'c' }, { op: 'move', from: 'a.txt', to: '.git/a.txt' }]) {
    assert.equal((await run(t, [operation])).problems[0].code, 'protected');
  }
});

test('a link that leads out of the folder cannot be used to reach outside it', async () => {
  const t = folder({ 'a.txt': 'A' });
  const outside = path.join(t.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  fs.symlinkSync(outside, path.join(t.root, 'escape'));
  for (const operation of [{ op: 'move', from: 'a.txt', to: 'escape/a.txt' }, { op: 'copy', from: 'a.txt', to: 'escape/a.txt' }, { op: 'trash', from: 'escape/secret.txt' }, { op: 'move', from: 'escape/secret.txt', to: 'got.txt' }, { op: 'mkdir', to: 'escape/new' }]) {
    const plan = await run(t, [operation]);
    assert.equal(plan.ok, false, JSON.stringify(operation));
    assert.equal(plan.problems[0].code, 'outside', JSON.stringify(operation));
  }
  // The link itself may be moved or trashed: that touches the link, not what it points at.
  assert.equal((await run(t, [{ op: 'move', from: 'escape', to: 'escape2' }])).ok, true);
  assert.equal(fs.existsSync(path.join(outside, 'secret.txt')), true);
});

test('a link is never copied, nor is a folder with one inside', async () => {
  const t = folder({ 'a.txt': 'A', 'd/x.txt': 'X' });
  fs.symlinkSync('a.txt', path.join(t.root, 'ln'));
  fs.symlinkSync('../a.txt', path.join(t.root, 'd', 'inner-ln'));
  assert.equal((await run(t, [{ op: 'copy', from: 'ln', to: 'ln2' }])).problems[0].code, 'symlink');
  assert.equal((await run(t, [{ op: 'copy', from: 'd', to: 'd2' }])).problems[0].code, 'symlink');
});

test('later operations see what earlier ones will have done', async () => {
  const t = folder({ 'a.txt': 'A', 'proj/src/m.txt': 'M' });
  assert.equal((await run(t, [{ op: 'mkdir', to: 'new' }, { op: 'move', from: 'a.txt', to: 'new/a.txt' }, { op: 'rename', from: 'new/a.txt', to: 'new/b.txt' }])).ok, true);
  // A folder moved, then something inside it by its new name, even deep inside.
  assert.equal((await run(t, [{ op: 'move', from: 'proj', to: 'proj2' }, { op: 'copy', from: 'proj2/src/m.txt', to: 'm-copy.txt' }])).ok, true);
  assert.equal((await run(t, [{ op: 'rename', from: 'proj', to: 'proj3' }, { op: 'move', from: 'proj3/src', to: 'src-out' }])).ok, true);
  // The old name is gone after a move, and a name taken by an earlier step is taken.
  assert.equal((await run(t, [{ op: 'move', from: 'a.txt', to: 'b.txt' }, { op: 'trash', from: 'a.txt' }])).problems[0].code, 'missing');
  assert.equal((await run(t, [{ op: 'mkdir', to: 'x' }, { op: 'mkdir', to: 'x' }])).problems[0].code, 'exists');
  assert.equal((await run(t, [{ op: 'trash', from: 'a.txt' }, { op: 'move', from: 'a.txt', to: 'z.txt' }])).problems[0].code, 'missing');
  // A chain of moves resolves back to the real file.
  assert.equal((await run(t, [{ op: 'move', from: 'a.txt', to: 'b.txt' }, { op: 'move', from: 'b.txt', to: 'c.txt' }, { op: 'copy', from: 'c.txt', to: 'd.txt' }])).ok, true);
});

test('a problem is reported against the operation that has it, and the plan cannot be applied', async () => {
  const t = folder({ 'a.txt': 'A' });
  const plan = await run(t, [{ op: 'mkdir', to: 'ok' }, { op: 'move', from: 'missing.txt', to: 'x' }, { op: 'trash', from: 'a.txt' }]);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.problems.map((problem) => problem.index), [1]);
  const result = await applyPlan({ root: t.root, operations: [{ op: 'mkdir', to: 'ok' }, { op: 'move', from: 'missing.txt', to: 'x' }], approvalDigest: plan.digest, journal: t.journal, trashItem: async () => {} });
  assert.equal(result.status, 'refused');
  assert.equal(exists(t, 'ok'), false);
});

// -------------------------------------------------------------------- apply ---

test('an approved plan is done, and recorded', async () => {
  const t = folder({ 'a.txt': 'A', 'd/x.txt': 'X' });
  const result = await apply(t, [{ op: 'mkdir', to: 'new' }, { op: 'move', from: 'a.txt', to: 'new/a.txt' }, { op: 'copy', from: 'd', to: 'd-copy' }, { op: 'rename', from: 'd', to: 'd2' }]);
  assert.equal(result.status, 'applied');
  assert.equal(fs.readFileSync(path.join(t.root, 'new/a.txt'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(t.root, 'd-copy/x.txt'), 'utf8'), 'X');
  assert.ok(exists(t, 'd2/x.txt') && !exists(t, 'd'));
  assert.equal(t.journal.list()[0].status, 'applied');
});

test('nothing happens without the approval for exactly this plan', async () => {
  const t = folder({ 'a.txt': 'A' });
  const operations = [{ op: 'move', from: 'a.txt', to: 'b.txt' }];
  for (const approvalDigest of [undefined, '', 'x', 'a'.repeat(64), (await run(t, [{ op: 'move', from: 'a.txt', to: 'c.txt' }])).digest]) {
    const result = await applyPlan({ root: t.root, operations, approvalDigest, journal: t.journal, trashItem: async () => {} });
    assert.equal(result.status, 'refused');
    assert.equal(result.error.code, 'not_approved');
  }
  assert.ok(exists(t, 'a.txt') && !exists(t, 'b.txt'));
});

test('if the folder changed after the preview, the approval no longer applies', async () => {
  const t = folder({ 'a.txt': 'A' });
  const operations = [{ op: 'move', from: 'a.txt', to: 'b.txt' }];
  const plan = await run(t, operations);
  fs.writeFileSync(path.join(t.root, 'b.txt'), 'someone made this');
  const result = await applyPlan({ root: t.root, operations, approvalDigest: plan.digest, journal: t.journal, trashItem: async () => {} });
  assert.equal(result.status, 'refused');
  assert.equal(fs.readFileSync(path.join(t.root, 'b.txt'), 'utf8'), 'someone made this');
});

test('a failing step takes back the ones before it: the folder is as it was', async () => {
  const t = folder({ 'a.txt': 'A', 'b.txt': 'B' });
  const operations = [{ op: 'mkdir', to: 'new' }, { op: 'move', from: 'a.txt', to: 'new/a.txt' }, { op: 'copy', from: 'b.txt', to: 'b2.txt' }, { op: 'rename', from: 'b.txt', to: 'c.txt' }];
  let renames = 0;
  const fsx = { ...fsp, rename: async (from, to) => { renames += 1; if (renames === 2) throw Object.assign(new Error('disk is full'), { code: 'ENOSPC' }); return fsp.rename(from, to); } };
  const result = await apply(t, operations, { fsx });
  assert.equal(result.status, 'rolled_back');
  assert.match(result.error.message, /disk is full/);
  assert.deepEqual(fs.readdirSync(t.root).sort(), ['a.txt', 'b.txt']);
  assert.equal(fs.readFileSync(path.join(t.root, 'a.txt'), 'utf8'), 'A');
});

test('the trash goes last, so a failure before it never loses a file', async () => {
  const t = folder({ 'a.txt': 'A', 'b.txt': 'B' });
  const operations = [{ op: 'trash', from: 'a.txt' }, { op: 'move', from: 'b.txt', to: 'nope/b.txt' }];
  // The second operation has a problem, so nothing is done at all.
  assert.equal((await apply(t, operations)).status, 'refused');
  assert.deepEqual(t.trashed, []);
  // A step that fails at run time: the trash has not happened yet.
  const good = [{ op: 'trash', from: 'a.txt' }, { op: 'rename', from: 'b.txt', to: 'c.txt' }];
  const fsx = { ...fsp, rename: async () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } };
  const result = await apply(t, good, { fsx });
  assert.equal(result.status, 'rolled_back');
  assert.deepEqual(t.trashed, []);
  assert.ok(exists(t, 'a.txt') && exists(t, 'b.txt'));
});

test('a trashed file is reported as not undoable if a later trash fails', async () => {
  const t = folder({ 'a.txt': 'A', 'b.txt': 'B' });
  let calls = 0;
  t.trashItem = async function trash(p) { calls += 1; if (calls === 2) throw new Error('trash unavailable'); this.trashed.push(p); await fsp.rm(p); };
  const result = await apply(t, [{ op: 'trash', from: 'a.txt' }, { op: 'trash', from: 'b.txt' }]);
  assert.equal(result.status, 'partial');
  assert.equal(result.stuck.length, 1);
  assert.match(result.stuck[0].message, /restore it from there/);
  assert.ok(exists(t, 'b.txt') && !exists(t, 'a.txt'));
  assert.equal(t.journal.list()[0].status, 'partial');
});

// --------------------------------------------------------------------- undo ---

test('an applied request can be undone, newest step first, and only once', async () => {
  const t = folder({ 'a.txt': 'A', 'd/x.txt': 'X' });
  const result = await apply(t, [{ op: 'mkdir', to: 'new' }, { op: 'move', from: 'a.txt', to: 'new/a.txt' }, { op: 'copy', from: 'd', to: 'd-copy' }, { op: 'rename', from: 'd', to: 'd2' }]);
  const undone = await undoRequest({ id: result.id, journal: t.journal });
  assert.equal(undone.undone.length, 4);
  assert.deepEqual(undone.notUndone, []);
  assert.deepEqual(fs.readdirSync(t.root).sort(), ['a.txt', 'd']);
  assert.equal(fs.readFileSync(path.join(t.root, 'a.txt'), 'utf8'), 'A');
  assert.ok(t.journal.list().find((entry) => entry.id === result.id).undoneAt);
  await assert.rejects(() => undoRequest({ id: result.id, journal: t.journal }), /already undone/);
});

test('undo restores what it can and says which files went to the trash', async () => {
  const t = folder({ 'a.txt': 'A', 'b.txt': 'B' });
  const result = await apply(t, [{ op: 'move', from: 'a.txt', to: 'a2.txt' }, { op: 'trash', from: 'b.txt' }]);
  const undone = await undoRequest({ id: result.id, journal: t.journal });
  assert.equal(undone.undone.length, 1);
  assert.deepEqual(undone.notUndone.map((step) => step.from), ['b.txt']);
  assert.ok(exists(t, 'a.txt') && !exists(t, 'b.txt'));
});

test('undo never guesses: it will not move a file back onto something that is there now', async () => {
  const t = folder({ 'a.txt': 'A' });
  const result = await apply(t, [{ op: 'move', from: 'a.txt', to: 'b.txt' }]);
  fs.writeFileSync(path.join(t.root, 'a.txt'), 'new file in the old place');
  const undone = await undoRequest({ id: result.id, journal: t.journal });
  assert.equal(undone.undone.length, 0);
  assert.match(undone.notUndone[0].reason, /is taken now/);
  assert.equal(fs.readFileSync(path.join(t.root, 'a.txt'), 'utf8'), 'new file in the old place');
  assert.ok(exists(t, 'b.txt'));
});

test('undo of an unknown, refused or failed request is refused', async () => {
  const t = folder({ 'a.txt': 'A' });
  await assert.rejects(() => undoRequest({ id: 'nope', journal: t.journal }), /no such request/);
  t.journal.add({ id: 'p1', at: Date.now(), root: t.root, status: 'partial', steps: [] });
  await assert.rejects(() => undoRequest({ id: 'p1', journal: t.journal }), /fully applied/);
});

test('the journal tolerates a torn line and lists newest first', () => {
  const t = folder();
  t.journal.add({ id: 'a', at: 1, status: 'applied', steps: [] });
  t.journal.add({ id: 'b', at: 2, status: 'applied', steps: [] });
  fs.appendFileSync(t.journal.file, '{"id":"c","at":');
  assert.deepEqual(t.journal.list().map((entry) => entry.id), ['b', 'a']);
  assert.equal(fs.statSync(t.journal.file).mode & 0o077, 0);
});

test('a case-only rename works where the system ignores case, and is not a clash', async () => {
  const t = folder({ 'readme.md': 'R' });
  const plan = await run(t, [{ op: 'rename', from: 'readme.md', to: 'README.md' }], { platform: 'darwin' });
  assert.equal(plan.ok, true);
  assert.equal((await run(folder({ 'a.txt': 'A', 'B.txt': 'B' }), [{ op: 'move', from: 'a.txt', to: 'b.txt' }], { platform: 'win32' })).problems[0].code, 'exists');
});
