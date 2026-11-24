'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * A record of what TheOne looked at, kept on this computer only: one line per look, and the picture.
 * Records older than the retention are deleted whenever something is added or looked at.
 */
class RecordStore {
  constructor({ dir, retentionDays = 7, now = () => Date.now() }) {
    this.dir = dir;
    this.retentionMs = Math.max(1, retentionDays) * 86_400_000;
    this.now = now;
    this.log = path.join(dir, 'computer-log.jsonl');
    this.shots = path.join(dir, 'computer-shots');
  }

  ensure() {
    fs.mkdirSync(this.shots, { recursive: true, mode: 0o700 });
  }

  entries() {
    let raw = '';
    try { raw = fs.readFileSync(this.log, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { const entry = JSON.parse(line); if (entry && typeof entry.id === 'string' && Number.isFinite(entry.at)) out.push(entry); } catch { /* a torn line is dropped */ }
    }
    return out;
  }

  add({ session, app, kind, image, note }) {
    this.ensure();
    this.prune();
    const id = crypto.randomBytes(8).toString('hex');
    const entry = { id, at: this.now(), session: String(session || '').slice(0, 120), app: String(app || '').slice(0, 80), kind: String(kind || '').slice(0, 30) };
    if (note) entry.note = String(note).slice(0, 200);
    if (image && image.length) {
      entry.file = `${id}.png`;
      fs.writeFileSync(path.join(this.shots, entry.file), image, { mode: 0o600 });
    }
    fs.appendFileSync(this.log, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    const all = this.entries();
    const keep = all.filter((entry) => entry.at >= cutoff);
    if (keep.length === all.length) return 0;
    for (const entry of all) if (entry.at < cutoff && entry.file) this.removeShot(entry.file);
    this.ensure();
    fs.writeFileSync(this.log, keep.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
    return all.length - keep.length;
  }

  removeShot(file) {
    // Only a plain file name this store wrote; never a path.
    if (!/^[0-9a-f]{16}\.png$/.test(file)) return;
    try { fs.rmSync(path.join(this.shots, file), { force: true }); } catch { /* already gone */ }
  }

  /** Everything, pictures included. */
  clear() {
    fs.rmSync(this.shots, { recursive: true, force: true });
    fs.rmSync(this.log, { force: true });
  }

  count() { this.prune(); return this.entries().length; }
}

module.exports = { RecordStore };
