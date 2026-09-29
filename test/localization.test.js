'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

test('native settings follows the locale selected by the web shell', () => {
  const preload = source('preload.js');
  const bridge = source('bridge.js');
  const main = source('main.js');
  const settings = source('settings.html');

  assert.match(preload, /openSettings: \(locale\)/);
  assert.match(bridge, /openSettings\(locale\)/);
  assert.match(main, /query: \{ lang: language \}/);
  assert.match(settings, /get\('lang'\) === 'en'/);
});

test('native settings has English copy for every static localized element', () => {
  const settings = source('settings.html');
  const keys = [...settings.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((match) => match[1]);
  const english = settings.match(/en: \{([\s\S]*?)\n    \}\n  \};/)?.[1] || '';
  assert.ok(keys.length > 10);
  for (const key of new Set(keys)) assert.match(english, new RegExp(`\\b${key}:`), `missing English copy for ${key}`);
});
