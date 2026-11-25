'use strict';

/**
 * The names a file operation may use. A path is always relative to the opened folder, written with
 * forward slashes, and made only of ordinary names: nothing absolute, nothing that climbs out, nothing a
 * Windows machine would refuse or treat as a device. The rules are the same on every system, so a plan
 * made on one computer means the same on another.
 */

const MAX_PATH = 1000;
const MAX_NAME = 255;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f<>:"|?*]/;

class FileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** `input` as a clean relative path, or a FileError saying why it is not one. */
function normalizeRel(input) {
  if (typeof input !== 'string') throw new FileError('bad_path', 'A path must be text.');
  const slashed = input.replace(/\\/g, '/');
  if (!slashed.trim()) throw new FileError('bad_path', 'A path cannot be empty.');
  if (slashed.length > MAX_PATH) throw new FileError('bad_path', 'That path is too long.');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) throw new FileError('outside', 'A path must be inside the folder, written relative to it.');
  const segments = slashed.replace(/\/+$/, '').split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') throw new FileError(segment === '..' ? 'outside' : 'bad_path', 'A path cannot contain empty, "." or ".." parts.');
    if (segment.length > MAX_NAME) throw new FileError('bad_path', 'A name in that path is too long.');
    if (BAD_CHARS.test(segment)) throw new FileError('bad_path', 'A name in that path has a character that is not allowed.');
    if (/[ .]$/.test(segment)) throw new FileError('bad_path', 'A name cannot end with a space or a dot.');
    if (RESERVED.test(segment)) throw new FileError('bad_path', `"${segment}" is a reserved name on Windows.`);
  }
  return segments.join('/');
}

/** Version-control internals are never touched through file management. */
function isProtected(rel) {
  return rel.split('/').some((segment) => segment.toLowerCase() === '.git');
}

const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const isUnder = (rel, ancestor) => rel === ancestor || rel.startsWith(`${ancestor}/`);

module.exports = { FileError, normalizeRel, isProtected, parentOf, baseOf, isUnder, MAX_PATH };
