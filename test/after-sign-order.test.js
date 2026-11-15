'use strict';
// The receipt digest must be taken AFTER the nested binaries are signed, and
// the outer bundle sealed again after the receipt is written. Source-order
// guard: the regression (refresh, then deep reseal) shipped a receipt that
// never matched the installed runtime.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'after-sign.cjs'), 'utf8');
const at = (needle) => source.indexOf(needle);

test('nested binaries are signed before the digest, the outer seal comes after', () => {
  const deepSign = at('resealMacApp(appPath, identity);');
  const refresh = at('await refreshRuntimeProvenance(runtimeRoot);');
  const outer = at('resealOuterMacApp(appPath, identity);');
  const verify = at('await verifyReceipt(runtimeRoot);');
  assert.ok(deepSign > 0 && refresh > deepSign, 'digest must follow the nested signature');
  assert.ok(outer > refresh, 'outer seal must follow the receipt write');
  assert.ok(verify > outer, 'the receipt is checked against the final bytes last');
});

test('the outer seal does not deep-sign nested code', () => {
  const body = source.slice(source.indexOf('function resealOuterMacApp'), source.indexOf('async function verifyReceipt'));
  assert.ok(!body.includes('--deep'));
});
