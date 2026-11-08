'use strict';

/**
 * What the native preview view may load.
 *
 * The preview is for the page the person's own project is serving, or a file
 * in a folder they opened. Everything else is the browser's job: a loopback
 * address, or an HTML/image/PDF file inside an opened folder (symlinks
 * resolved, so a link cannot lead out of it). Nothing here touches Electron,
 * so the rules can be tested without launching it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

/** Files a person can look at in the view: pages, images, PDF. No scripts, no data files. */
const FILE_EXTENSIONS = new Set(['.html', '.htm', '.xhtml', '.svg', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost');
}

/** "3000", ":5173", "localhost:8080/app", "http://127.0.0.1:4000" → a loopback http(s) URL, or null. */
function loopbackUrl(input) {
  let text = String(input || '').trim();
  if (!text || /\s/.test(text)) return null;
  if (/^:?\d{2,5}$/.test(text)) text = `http://localhost:${text.replace(':', '')}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!isLoopbackHost(url.hostname)) return null;
  if (url.hostname === '0.0.0.0') url.hostname = 'localhost';
  return url.toString();
}

function realpathOrNull(target, fsImpl) {
  try { return fsImpl.realpathSync(target); } catch { return null; }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A file URL or absolute path inside an opened folder (after resolving links), as a file URL, or null. */
function fileUrl(input, workspaces, fsImpl = fs) {
  const text = String(input || '').trim();
  if (!text) return null;
  let filePath;
  try {
    if (/^file:/i.test(text)) filePath = fileURLToPath(text);
    else if (path.isAbsolute(text)) filePath = text;
    else return null;
  } catch { return null; }
  const real = realpathOrNull(filePath, fsImpl);
  if (!real || !FILE_EXTENSIONS.has(path.extname(real).toLowerCase())) return null;
  let stat;
  try { stat = fsImpl.statSync(real); } catch { return null; }
  if (!stat.isFile()) return null;
  const roots = (Array.isArray(workspaces) ? workspaces : []).map((item) => realpathOrNull(String(item || ''), fsImpl)).filter(Boolean);
  if (!roots.some((root) => isInside(root, real))) return null;
  return pathToFileURL(real).href;
}

/**
 * What to load for what the person typed: { ok: true, url, kind } or { ok: false, reason }.
 */
function previewTarget(input, workspaces, fsImpl = fs) {
  const text = String(input || '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (/^file:/i.test(text) || path.isAbsolute(text)) {
    const url = fileUrl(text, workspaces, fsImpl);
    return url ? { ok: true, url, kind: 'file' } : { ok: false, reason: 'file_not_in_opened_folder' };
  }
  const url = loopbackUrl(text);
  return url ? { ok: true, url, kind: 'http' } : { ok: false, reason: 'not_local' };
}

/** The page's rectangle, in the window's coordinates, kept inside the window and made whole numbers. */
function clampBounds(rect, size, zoom = 1) {
  const factor = Number(zoom) > 0 ? Number(zoom) : 1;
  const pick = (value) => (Number.isFinite(Number(value)) ? Number(value) * factor : 0);
  const maxW = Math.max(0, Math.floor(Number(size && size.width) || 0));
  const maxH = Math.max(0, Math.floor(Number(size && size.height) || 0));
  const x = Math.min(Math.max(0, Math.round(pick(rect && rect.x))), maxW);
  const y = Math.min(Math.max(0, Math.round(pick(rect && rect.y))), maxH);
  const width = Math.min(Math.max(0, Math.round(pick(rect && rect.width))), maxW - x);
  const height = Math.min(Math.max(0, Math.round(pick(rect && rect.height))), maxH - y);
  return { x, y, width, height };
}

module.exports = { FILE_EXTENSIONS, clampBounds, fileUrl, isLoopbackHost, loopbackUrl, previewTarget };
