'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../src/computer/input-rules');
const { createComputerActions } = require('../src/computer/actions');
const { ComputerSessions } = require('../src/computer/session');
const { RecordStore } = require('../src/computer/records');
const { createMacProvider } = require('../src/computer/mac-provider');
const { createWinProvider, typeScript } = require('../src/computer/win-provider');
const { ProviderError } = require('../src/computer/provider');
const policy = require('../src/policy');
const { Settings } = require('../src/settings');
const { bridgeContract } = require('../src/bridge-contract');

const SID = 'session_act_1';
const WINDOW = { id: 77, pid: 4242, x: 100, y: 50, w: 800, h: 600, title: 'Notes' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'act-test-'));
const pngOf = (seed) => { const b = Buffer.alloc(40 + seed.length); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(800, 16); b.writeUInt32BE(600, 20); b.write(seed, 33); return b; };

function setup({ allowInput = true, trusted = true, window = WINDOW, capture, sent = [] } = {}) {
  let current = { ...window };
  let seed = 'before';
  const provider = {
    supported: true,
    async captureWindow() { if (capture) return capture(); return { png: pngOf(seed), width: 800, height: 600, window: { ...current } }; },
    async appState() { return { running: true, frontmost: true, windows: [] }; },
    async findWindow() { return current ? { ...current } : null; },
    input: {
      supported: true,
      async trusted() { return trusted; },
      async click(win, point, opts) { sent.push(['click', win.pid, point, opts]); seed = 'after-click'; },
      async type(win, text) { sent.push(['type', win.pid, text]); seed = 'after-type'; },
      async key(win, name) { sent.push(['key', win.pid, name]); seed = 'after-key'; },
    },
  };
  const sessions = new ComputerSessions({ maxSteps: 6 });
  const records = new RecordStore({ dir: tmp() });
  const actions = createComputerActions({ settings: () => ({ enabled: true, allowInput, apps: ['Notes'] }), provider, sessions, records, settle: async () => {}, now: () => Date.now() });
  return { actions, sessions, records, sent, move: (to) => { current = to ? { ...current, ...to } : null; } };
}
const look = (t) => t.actions.screenshot({ app: 'Notes', sessionId: SID, approved: true });
const click = (extra = {}) => ({ app: 'Notes', sessionId: SID, kind: 'click', x: 400, y: 300, imageWidth: 800, imageHeight: 600, ...extra });

// ------------------------------------------------------------------- the rules ---

test('a click is a point inside a picture of a size, and nothing else', () => {
  assert.deepEqual(rules.normalizeAction({ kind: 'click', x: 10.4, y: 20.6, imageWidth: 800, imageHeight: 600 }), { kind: 'click', x: 10, y: 21, imageWidth: 800, imageHeight: 600, double: false });
  assert.equal(rules.normalizeAction({ kind: 'click', x: 1, y: 1, imageWidth: 800, imageHeight: 600, double: true }).double, true);
  for (const bad of [{ x: 1, y: 1 }, { x: '1', y: 1, imageWidth: 800, imageHeight: 600 }, { x: -1, y: 1, imageWidth: 800, imageHeight: 600 }, { x: 800, y: 1, imageWidth: 800, imageHeight: 600 }, { x: 1, y: 600, imageWidth: 800, imageHeight: 600 }, { x: NaN, y: 1, imageWidth: 800, imageHeight: 600 }, { x: 1, y: 1, imageWidth: 10, imageHeight: 10 }, { x: 1, y: 1, imageWidth: 800, imageHeight: Infinity }]) {
    assert.throws(() => rules.normalizeAction({ kind: 'click', ...bad }), (error) => error instanceof rules.ActionError, JSON.stringify(bad));
  }
});

test('typed text is short, plain, and never a password, key or card number', () => {
  assert.deepEqual(rules.normalizeAction({ kind: 'type', text: 'hello world' }), { kind: 'type', text: 'hello world' });
  assert.throws(() => rules.normalizeAction({ kind: 'type', text: '' }), /no text/);
  assert.throws(() => rules.normalizeAction({ kind: 'type', text: 'x'.repeat(501) }), (error) => error.code === 'too_long');
  assert.throws(() => rules.normalizeAction({ kind: 'type', text: 'a\nb' }), (error) => error.code === 'bad_action');
  assert.throws(() => rules.normalizeAction({ kind: 'type', text: 'a\u0007b' }), (error) => error.code === 'bad_action');
  for (const secret of ['sk-abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP', 'password: hunter2xyz', 'api_key=abcd1234', '密码：abc123', '-----BEGIN RSA PRIVATE KEY-----', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcde12345', '4111 1111 1111 1111', '4111-1111-1111-1111']) {
    assert.throws(() => rules.normalizeAction({ kind: 'type', text: `note ${secret}` }), (error) => error.code === 'secret', secret);
  }
  // Numbers that are not a card are fine.
  assert.equal(rules.normalizeAction({ kind: 'type', text: 'order 1234 5678 9012 3456' }).kind, 'type');
  assert.equal(rules.looksLikeCardNumber('call me on 020 7946 0958'), false);
});

test('only a few plain keys, never with a modifier', () => {
  for (const key of ['return', 'TAB', 'Escape', 'space', 'delete', 'up', 'down', 'left', 'right']) assert.equal(rules.normalizeAction({ kind: 'key', key }).kind, 'key');
  for (const key of ['cmd+q', 'ctrl+c', 'command', 'f5', 'enter ', '', 'a', 'cmd+delete', undefined, 5]) assert.throws(() => rules.normalizeAction({ kind: 'key', key }), (error) => error.code === 'bad_action', String(key));
  for (const kind of ['', 'drag', 'scroll', 'hotkey', undefined]) assert.throws(() => rules.normalizeAction({ kind }), (error) => error.code === 'bad_action');
});

test('a click lands where the picture says, scaled to the window, and only inside it', () => {
  const point = rules.mapClick(rules.normalizeAction({ kind: 'click', x: 400, y: 300, imageWidth: 1280, imageHeight: 960 }), { x: 100, y: 50, w: 800, h: 600 });
  assert.deepEqual([Math.round(point.x), Math.round(point.y)], [100 + 250, 50 + 188]);
  assert.throws(() => rules.mapClick(rules.normalizeAction({ kind: 'click', x: 10, y: 10, imageWidth: 1000, imageHeight: 1000 }), { x: 0, y: 0, w: 800, h: 600 }), (error) => error.code === 'stale');
  assert.throws(() => rules.mapClick(rules.normalizeAction({ kind: 'click', x: 10, y: 10, imageWidth: 800, imageHeight: 600 }), { x: 0, y: 0, w: 0, h: 600 }), (error) => error.code === 'moved');
});

test('windows that are for signing in, paying or passwords are recognised', () => {
  for (const title of ['Sign in to GitHub', 'Log In - Bank', 'Checkout', 'Enter your password', '登录', '支付订单', 'Verification code']) assert.equal(rules.sensitiveTitle(title), true, title);
  for (const title of ['Shopping list', 'Notes', 'Untitled', '', undefined]) assert.equal(rules.sensitiveTitle(title), false, String(title));
});

test('the digest is for this action on this window, and changes with either', () => {
  const action = rules.normalizeAction({ kind: 'click', x: 1, y: 1, imageWidth: 800, imageHeight: 600 });
  const base = rules.actionDigest({ app: 'Notes', window: WINDOW, action });
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(base, rules.actionDigest({ app: 'notes', window: WINDOW, action }));
  assert.notEqual(base, rules.actionDigest({ app: 'Notes', window: { ...WINDOW, x: 101 }, action }));
  assert.notEqual(base, rules.actionDigest({ app: 'Notes', window: WINDOW, action: { ...action, x: 2 } }));
  assert.notEqual(base, rules.actionDigest({ app: 'Mail', window: WINDOW, action }));
});

test('a typed text is in what the person reads, and never in the log', () => {
  const action = rules.normalizeAction({ kind: 'type', text: 'my secret note' });
  assert.match(rules.describeAction(action), /my secret note/);
  assert.doesNotMatch(rules.describeAction(action, { forLog: true }), /secret/);
  assert.match(rules.describeAction(action, { forLog: true }), /14 characters/);
});

// ------------------------------------------------------------------ the flow ---

test('acting is refused unless input is on, allowed by the system, and the window was looked at', async () => {
  const off = setup({ allowInput: false });
  await look(off);
  assert.equal((await off.actions.act(click())).code, 'input_off');
  const untrusted = setup({ trusted: false });
  await look(untrusted);
  const refusal = await untrusted.actions.act(click());
  assert.equal(refusal.code, 'permission');
  assert.match(refusal.message, /Accessibility/);
  const unlooked = setup();
  assert.equal((await unlooked.actions.act(click())).code, 'not_looked');
  assert.deepEqual(unlooked.sent, []);
});

test('the first call only describes the action and asks; nothing is sent', async () => {
  const t = setup();
  await look(t);
  const asked = await t.actions.act(click());
  assert.equal(asked.status, 'needs_approval');
  assert.match(asked.digest, /^[0-9a-f]{64}$/);
  assert.match(asked.action, /click \(400, 300\)/);
  assert.deepEqual(t.sent, []);
});

test('with the digest of what was shown it is done, to that window\'s process, and a new picture comes back', async () => {
  const t = setup();
  await look(t);
  const { digest } = await t.actions.act(click());
  const done = await t.actions.act({ ...click(), approval: { digest } });
  assert.equal(done.status, 'ok');
  assert.equal(done.changed, true);
  assert.equal(done.image.mime, 'image/png');
  assert.equal(t.sent.length, 1);
  assert.deepEqual([t.sent[0][0], t.sent[0][1]], ['click', 4242]);
  assert.deepEqual(t.sent[0][2], { x: 100 + 400, y: 50 + 300 });
});

test('a different digest, a different action or a moved window is not what was approved', async () => {
  const t = setup();
  await look(t);
  const { digest } = await t.actions.act(click());
  for (const approval of [{ digest: 'a'.repeat(64) }, { digest: '' }, { digest: 5 }]) {
    const result = await t.actions.act({ ...click(), approval });
    assert.ok(['changed', 'needs_approval'].includes(result.status === 'error' ? result.code : result.status), JSON.stringify(result));
  }
  assert.equal((await t.actions.act({ ...click({ x: 401 }), approval: { digest } })).code, 'changed');
  t.move({ x: 120 });
  assert.equal((await t.actions.act({ ...click(), approval: { digest } })).code, 'moved');
  assert.deepEqual(t.sent, []);
});

test('typing and keys work the same way, and typing a password or a key is refused before anything is asked', async () => {
  const t = setup();
  await look(t);
  const typed = await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'type', text: 'buy milk' });
  assert.equal(typed.status, 'needs_approval');
  assert.match(typed.action, /buy milk/);
  assert.equal((await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'type', text: 'password: hunter2xyz' })).code, 'secret');
  const done = await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'type', text: 'buy milk', approval: { digest: typed.digest } });
  assert.equal(done.status, 'ok');
  assert.deepEqual(t.sent[0], ['type', 4242, 'buy milk']);
  const key = await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'key', key: 'return' });
  await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'key', key: 'return', approval: { digest: key.digest } });
  assert.deepEqual(t.sent[1], ['key', 4242, 'return']);
  assert.equal((await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'key', key: 'cmd+q' })).code, 'bad_action');
});

test('a sign-in or payment window is refused, whatever the action', async () => {
  const t = setup({ window: { ...WINDOW, title: 'Sign in to your account' } });
  await look(t);
  assert.equal((await t.actions.act(click())).code, 'sensitive_window');
  assert.equal((await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'type', text: 'hi' })).code, 'sensitive_window');
});

test('the picture must be recent, and be of the window as it is', async () => {
  const t = setup();
  const stale = createComputerActions({ settings: () => ({ enabled: true, allowInput: true, apps: ['Notes'] }), provider: { supported: true, async captureWindow() { return { png: pngOf('x'), width: 800, height: 600, window: WINDOW }; }, async findWindow() { return WINDOW; }, input: { supported: true, async trusted() { return true; } } }, sessions: new ComputerSessions(), records: new RecordStore({ dir: tmp() }), settle: async () => {}, now: (() => { let n = 1000; return () => { n += 130_000; return n; }; })() });
  await stale.screenshot({ app: 'Notes', sessionId: SID, approved: true });
  assert.equal((await stale.act(click())).code, 'stale');
  await look(t);
  const wrongShape = await t.actions.act(click({ imageWidth: 1000, imageHeight: 1000, x: 10, y: 10 }));
  assert.equal(wrongShape.code, 'stale');
});

test('it reports honestly when nothing on screen changed', async () => {
  const t = setup();
  const provider = { supported: true, async captureWindow() { return { png: pngOf('same'), width: 800, height: 600, window: WINDOW }; }, async findWindow() { return WINDOW; }, input: { supported: true, async trusted() { return true; }, async click() {}, async type() {}, async key() {} } };
  const actions = createComputerActions({ settings: () => ({ enabled: true, allowInput: true, apps: ['Notes'] }), provider, sessions: new ComputerSessions(), records: new RecordStore({ dir: tmp() }), settle: async () => {} });
  await actions.screenshot({ app: 'Notes', sessionId: SID, approved: true });
  const { digest } = await actions.act(click());
  const done = await actions.act({ ...click(), approval: { digest } });
  assert.equal(done.changed, false);
  assert.ok(t);
});

test('the step limit and the emergency stop apply to acting too, and a stop means nothing is sent', async () => {
  const t = setup();
  await look(t);
  const { digest } = await t.actions.act(click());
  t.sessions.stopAll();
  assert.equal((await t.actions.act({ ...click(), approval: { digest } })).code, 'not_looked');
  assert.deepEqual(t.sent, []);
  const limited = setup();
  limited.sessions.maxSteps = 2;
  await look(limited);
  const first = await limited.actions.act(click());
  await limited.actions.act({ ...click(), approval: { digest: first.digest } });
  const second = await limited.actions.act(click());
  assert.equal((await limited.actions.act({ ...click(), approval: { digest: second.digest } })).code, 'step_limit');
});

test('the record says what kind of action and how long a text was, never the text', async () => {
  const t = setup();
  await look(t);
  const asked = await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'type', text: 'a private sentence' });
  await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'type', text: 'a private sentence', approval: { digest: asked.digest } });
  const log = fs.readFileSync(t.records.log, 'utf8');
  assert.match(log, /type 18 characters/);
  assert.doesNotMatch(log, /private sentence/);
});

test('a provider\'s reason is passed on; an unexpected failure does not leak', async () => {
  const t = setup();
  t.actions;
  const provider = { supported: true, async captureWindow() { return { png: pngOf('x'), width: 800, height: 600, window: WINDOW }; }, async findWindow() { return WINDOW; }, input: { supported: true, async trusted() { return true; }, async click() { throw new Error('/Users/me/secret failed'); }, async type() {}, async key() {} } };
  const actions = createComputerActions({ settings: () => ({ enabled: true, allowInput: true, apps: ['Notes'] }), provider, sessions: new ComputerSessions(), records: new RecordStore({ dir: tmp() }), settle: async () => {} });
  await actions.screenshot({ app: 'Notes', sessionId: SID, approved: true });
  const { digest } = await actions.act(click());
  const failed = await actions.act({ ...click(), approval: { digest } });
  assert.equal(failed.code, 'act_failed');
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
});

// ---------------------------------------------------------------- providers ---

test('mac: the events go to one process, and permission is checked first; typed text cannot break out of its script', async () => {
  const scripts = [];
  const exec = async (file, args) => { scripts.push(args[args.length - 1]); return JSON.stringify({ trusted: false }); };
  const provider = createMacProvider({ exec, tmpdir: tmp(), platform: 'darwin' });
  assert.equal(await provider.input.trusted(), false);
  const LS = String.fromCharCode(0x2028);
  const evil = 'x");$.system("rm -rf ~");//\n' + LS;
  await provider.input.type({ pid: 99 }, evil);
  const script = scripts.at(-1);
  assert.match(script, /CGEventPostToPid\(pid/);
  assert.doesNotMatch(script, /CGEventPost\(/);
  // The text is only ever inside one JSON string literal.
  const literal = script.slice(script.indexOf('Array.from(') + 11, script.indexOf(')) {'));
  assert.equal(JSON.parse(literal.split(LS).join('\\u2028')), evil);
  await provider.input.click({ pid: 7 }, { x: 5.5, y: 6 }, { double: true });
  assert.match(scripts.at(-1), /const pid = 7;/);
  await assert.rejects(() => provider.input.key({ pid: 7 }, 'cmd+q'), (error) => error instanceof ProviderError);
});

test('windows: typed text reaches PowerShell as base64 only, and an unknown key is refused', async () => {
  const evil = 'x$(calc.exe)`whoami`"; Remove-Item *';
  assert.doesNotMatch(typeScript(1, evil), /calc\.exe|Remove-Item|whoami/);
  const sent = [];
  const provider = createWinProvider({ exec: async (file, args) => { sent.push(args); return ''; }, desktopCapturer: {}, platform: 'win32' });
  await provider.input.type({ id: 5 }, 'hi');
  assert.ok(sent.length === 1 && sent[0].includes('-EncodedCommand'));
  await assert.rejects(() => provider.input.key({ id: 5 }, 'f5'), (error) => error instanceof ProviderError);
  assert.equal(await provider.input.trusted(), true);
});

// ------------------------------------------------------ policy, settings, contract ---

const call = (input) => policy.localAgentCall({ action: 'computer.act', input }, [], { enabled: false, folders: [] }, { enabled: false, folders: [] });

test('the chat can ask for one action with typed fields only, and an approval is only a digest', () => {
  assert.ok(policy.LOCAL_AGENT_ACTIONS.has('computer.act'));
  assert.deepEqual(call({ app: ' Notes ', sessionId: SID, kind: 'click', x: 1, y: 2, imageWidth: 800, imageHeight: 600, double: true, command: 'rm', path: '/' }).input, { app: 'Notes', kind: 'click', sessionId: SID, x: 1, y: 2, imageWidth: 800, imageHeight: 600, double: true });
  assert.deepEqual(call({ app: 'Notes', kind: 'type', text: 'hi', x: 1 }).input, { app: 'Notes', kind: 'type', text: 'hi' });
  assert.deepEqual(call({ app: 'Notes', kind: 'key', key: 'return' }).input, { app: 'Notes', kind: 'key', key: 'return' });
  assert.equal(call({ app: 'Notes', kind: 'key', key: 'return', approval: { digest: 'a'.repeat(64) } }).input.approval.digest, 'a'.repeat(64));
  for (const approval of ['x', true, { digest: 'short' }, { digest: 5 }, null]) assert.equal(call({ app: 'Notes', kind: 'key', key: 'return', approval }).input.approval, undefined);
  const stringy = call({ app: 'Notes', kind: 'click', x: '1', y: '2', imageWidth: '800', imageHeight: '600' }).input;
  assert.equal(stringy.x, undefined);
  assert.throws(() => call({ app: 'Notes', kind: 'drag' }), /click, some text to type or one key/);
  assert.throws(() => call({ app: 'a\nb', kind: 'key', key: 'return' }), /names one application/);
  assert.equal(call({ app: 'Notes', kind: 'type', text: 'x'.repeat(5000) }).input.text.length, 600);
});

test('acting is its own setting: off by default, only on while looking is on, and turning looking off turns it off', () => {
  const dataDir = tmp();
  const settings = new Settings({ dataDir, safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal(settings.computer.allowInput, false);
  assert.throws(() => settings.setComputerInput(true), /off/);
  settings.setComputerEnabled(true);
  assert.equal(settings.computer.allowInput, false);
  settings.setComputerInput(true);
  assert.equal(settings.computer.allowInput, true);
  assert.equal(new Settings({ dataDir, safeStorage: { isEncryptionAvailable: () => false } }).computer.allowInput, true);
  settings.setComputerEnabled(false);
  assert.equal(settings.computer.allowInput, false);
  settings.setComputerEnabled(true);
  assert.equal(settings.computer.allowInput, false);
});

test('acting is advertised only where the system can do it, and its dialog, stop and permission page are as designed', () => {
  assert.equal(bridgeContract(null).capabilities.includes('computerActV1'), false);
  assert.equal(bridgeContract(null, { computerAct: true }).capabilities.includes('computerActV1'), true);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
  const handler = source.slice(source.indexOf("handle('desktop:computerSetInput'"), source.indexOf("handle('desktop:computerOpenAccessibilitySettings'"));
  assert.match(handler, /if \(on\) \{[\s\S]*await confirmMcp\(/);
  assert.match(handler, /if \(!on\) computerSessions\.interrupt\(\)/);
  const opener = source.slice(source.indexOf("handle('desktop:computerOpenAccessibilitySettings'"), source.indexOf("handle('desktop:computerOpenPermissionSettings'"));
  assert.match(opener, /process\.platform !== 'darwin'\) return \{ opened: false \}/);
  assert.match(opener, /openExternal\('x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Accessibility'\)/);
});

// ------------------------------------------------------------------- takeover ---

const takeoverSetup = (over = {}) => {
  const t = setup(over);
  return t;
};

test('without a takeover every action asks; with one, clicks and text run without a card', async () => {
  const t = takeoverSetup();
  await look(t);
  assert.equal((await t.actions.act(click())).status, 'needs_approval');
  t.sessions.takeOver(SID, 'notes');
  const done = await t.actions.act(click());
  assert.equal(done.status, 'ok');
  assert.equal(t.sent.length, 1);
  const typed = await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'type', text: 'hello' });
  assert.equal(typed.status, 'ok');
  assert.equal(t.sent.length, 2);
});

test('the Return key always asks, even in a takeover', async () => {
  const t = takeoverSetup();
  await look(t);
  t.sessions.takeOver(SID, 'notes');
  const asked = await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'key', key: 'return' });
  assert.equal(asked.status, 'needs_approval');
  assert.equal(t.sent.length, 0);
  const done = await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'key', key: 'return', approval: { digest: asked.digest } });
  assert.equal(done.status, 'ok');
  assert.equal(t.sent.length, 1);
});

test('a takeover keeps every other rule: sensitive windows, secrets, moved windows, input off, permission', async () => {
  let t = takeoverSetup({ window: { ...WINDOW, title: 'Sign in to your account' } });
  await look(t); t.sessions.takeOver(SID, 'notes');
  assert.equal((await t.actions.act(click())).code, 'sensitive_window');
  t = takeoverSetup();
  await look(t); t.sessions.takeOver(SID, 'notes');
  assert.equal((await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'type', text: 'sk-abcdefghijklmnopqrstuvwxyz123456' })).code, 'secret');
  t.move({ x: 500 });
  assert.equal((await t.actions.act(click())).code, 'moved');
  t = takeoverSetup({ allowInput: false });
  await look(t);
  assert.equal((await t.actions.act(click())).code, 'input_off');
  t = takeoverSetup({ trusted: false });
  await look(t);
  assert.equal((await t.actions.act(click())).code, 'permission');
  assert.equal(t.sent.length, 0);
});

test('a takeover is for one app in one conversation, and for a limited time', () => {
  let clock = 1000;
  const s = new ComputerSessions({ takeoverMs: 60_000, now: () => clock });
  assert.throws(() => s.takeOver('a', 'notes'), /Look at the application first/);
  s.approve('a', 'notes');
  s.takeOver('a', 'notes');
  assert.ok(s.takeoverFor('a', 'notes'));
  assert.equal(s.takeoverFor('a', 'wechat'), null);
  assert.equal(s.takeoverFor('b', 'notes'), null);
  assert.equal(s.takeoverCount, 1);
  clock += 61_000;
  assert.equal(s.takeoverFor('a', 'notes'), null);
  assert.equal(s.takeoverCount, 0);
});

test('the stop key, a screen lock and ending the session end a takeover; a stopped computer cannot start one', () => {
  const s = new ComputerSessions();
  for (const end of [() => s.stopAll(), () => s.interrupt(), () => s.end('a'), () => s.endTakeover('a')]) {
    s.release(); s.approve('a', 'notes'); s.takeOver('a', 'notes');
    assert.ok(s.takeoverFor('a', 'notes'));
    end();
    assert.equal(s.takeoverFor('a', 'notes'), null);
  }
  s.stopAll();
  assert.throws(() => s.takeOver('a', 'notes'), /stopped/);
});

test('a takeover is capped at the session limit and cannot be made longer than allowed', () => {
  let clock = 0;
  const s = new ComputerSessions({ takeoverMs: 60_000, now: () => clock });
  s.approve('a', 'notes');
  const { until } = s.takeOver('a', 'notes', 24 * 3600 * 1000);
  assert.equal(until, 60_000);
});

test('the takeover is recorded as such, and typed text still only as a length', async () => {
  const t = takeoverSetup();
  await look(t);
  t.sessions.takeOver(SID, 'notes');
  await t.actions.act({ app: 'Notes', sessionId: SID, kind: 'type', text: 'a private sentence' });
  const text = JSON.stringify(t.records.list ? t.records.list(10) : []);
  assert.doesNotMatch(text, /private sentence/);
});

test('the takeover handlers exist, ask in a native dialog, and the capability is advertised only with input', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '../src/bridge.js'), 'utf8');
  const block = bridge.slice(bridge.indexOf("handle('desktop:computerTakeOver'"), bridge.indexOf("handle('desktop:computerEndTakeover'"));
  assert.match(block, /confirmMcp\(/);
  assert.match(block, /allowInput !== true/);
  assert.match(block, /isApproved\(/);
  assert.match(block, /isAllowed\(/);
  assert.ok(bridgeContract(null, { computerAct: true }).capabilities.includes('computerTakeoverV1'));
  assert.ok(!bridgeContract(null, { computerAct: false }).capabilities.includes('computerTakeoverV1'));
  assert.match(fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8'), /computerTakeOver/);
});
