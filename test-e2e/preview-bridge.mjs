// The preview through the real app: preload → IPC → origin guard → view.
//
//   node test-e2e/preview-bridge.mjs
//
// Launches the real desktop app against a stand-in TheOne page (a local server),
// then drives window.theoneDesktop.preview from that page exactly as the TheOne
// page does. Exits 1 on any failure.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_CORE || path.resolve('../oneclaw-v5-phase4/node_modules/playwright-core');
const { _electron: electron } = require(playwrightPath);

const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler); server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })); });
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? true : `FAILED${detail ? `: ${detail}` : ''}`; };

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-bridge-'));
const dataDir = path.join(scratch, 'data');
const project = path.join(scratch, 'project');
const outside = path.join(scratch, 'outside');
for (const dir of [dataDir, project, outside]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(project, 'index.html'), '<title>project file</title><h1>hello</h1>');
fs.writeFileSync(path.join(outside, 'private.html'), '<title>private</title>');
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ workspaces: [project] }));

const dev = await listen((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>dev ${req.url}</title><h1>DEV ${req.url}</h1>`); });
// Stand-in for TheOne: the app only loads (and gives the bridge to) the origin it was started for.
const host = await listen((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>TheOne stand-in</title><div id="slot" style="position:absolute;left:300px;top:100px;width:600px;height:400px"></div>'); });

const app = await electron.launch({
  executablePath: require(path.resolve('node_modules/electron')),
  args: ['.'],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, THEONE_DESKTOP_URL: `http://127.0.0.1:${host.port}/os`, THEONE_DESKTOP_DATA_DIR: dataDir },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(window.theoneDesktop && window.theoneDesktop.preview), null, { timeout: 30_000 });
  check('preview_api_exposed', true);
  const names = await page.evaluate(() => Object.keys(window.theoneDesktop.preview).sort());
  check('api_surface', ['back', 'capture', 'close', 'devtools', 'forward', 'open', 'reload', 'setBounds', 'setVisible', 'state', 'stop'].every((n) => names.includes(n)), names.join());

  const rect = { x: 300, y: 100, width: 600, height: 400 };
  const opened = await page.evaluate(({ port, rect }) => window.theoneDesktop.preview.open(String(port), rect), { port: dev.port, rect });
  check('open_dev_server', opened.ok === true && opened.url === `http://localhost:${dev.port}/`, JSON.stringify(opened));

  const state = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const s = await page.evaluate(() => window.theoneDesktop.preview.state());
      if (s.title === 'dev /') return s;
      await page.waitForTimeout(100);
    }
    return page.evaluate(() => window.theoneDesktop.preview.state());
  })();
  check('state_reports_page', state.open && state.title === 'dev /' && state.loading === false, JSON.stringify(state));

  const events = await page.evaluate(() => new Promise((resolve) => {
    const seen = [];
    const off = window.theoneDesktop.onEvent((event) => { if (event.type === 'preview') seen.push(event); });
    window.theoneDesktop.preview.reload();
    setTimeout(() => { off(); resolve(seen.length); }, 800);
  }));
  check('state_events_pushed_to_page', events > 0, String(events));

  const shot = await page.evaluate(() => window.theoneDesktop.preview.capture());
  check('capture', shot.ok === true && /^data:image\/png;base64,/.test(shot.dataUrl) && shot.width > 50, shot.error);

  for (const [label, input] of [['other_host', 'https://example.com'], ['metadata_ip', 'http://169.254.169.254/'], ['outside_folder', path.join(outside, 'private.html')], ['script_scheme', 'javascript:alert(1)']]) {
    const refused = await page.evaluate((value) => window.theoneDesktop.preview.open(value), input);
    check(`refuse_${label}`, refused.ok === false, JSON.stringify(refused));
  }
  const file = await page.evaluate((value) => window.theoneDesktop.preview.open(value), path.join(project, 'index.html'));
  check('open_project_file', file.ok === true && file.url.startsWith('file://'), JSON.stringify(file));
  await page.waitForTimeout(500);
  const afterFile = await page.evaluate(() => window.theoneDesktop.preview.state());
  check('file_title', afterFile.title === 'project file', JSON.stringify(afterFile));
  await page.evaluate(() => window.theoneDesktop.preview.back());
  await page.waitForTimeout(600);
  const afterBack = await page.evaluate(() => window.theoneDesktop.preview.state());
  check('back_works', afterBack.title === 'dev /', JSON.stringify(afterBack));

  await page.evaluate(() => window.theoneDesktop.preview.setVisible(false));
  await page.evaluate(() => window.theoneDesktop.preview.setBounds({ x: 10, y: 10, width: 200, height: 200 }));
  const closed = await page.evaluate(async () => { await window.theoneDesktop.preview.close(); return window.theoneDesktop.preview.state(); });
  check('close', closed.open === false && closed.url === '', JSON.stringify(closed));
} catch (error) {
  check('no_exception', false, String(error && error.stack || error));
} finally {
  await app.close().catch(() => {});
  dev.server.close(); host.server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  const failed = Object.entries(results).filter(([, value]) => value !== true);
  for (const [name, value] of Object.entries(results)) console.log(`${value === true ? 'PASS' : 'FAIL'} ${name}${value === true ? '' : ` ${value}`}`);
  process.exit(failed.length ? 1 : 0);
}
