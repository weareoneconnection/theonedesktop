'use strict';

// The preview view in the real Electron this app ships with:
//
//   npm run test:preview
//
// A hidden window, two local servers and a scratch "opened folder". Checks that
// a local page loads and can be captured, that nothing outside the folder or off
// this machine loads, that a page cannot navigate the view away or open windows
// elsewhere, and that back / forward / bounds / close behave. Exits 1 on any failure.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');
const { createPreview } = require('../src/preview');

// (hardware acceleration left on: capturePage needs the compositor)

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? true : `FAILED${detail ? `: ${detail}` : ''}`; };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serve(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const page = typeof html === 'function' ? html(req.url) : html;
      res.end(page);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitFor(predicate, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await wait(80);
  }
  return false;
}

app.whenReady().then(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-e2e-'));
  const folder = path.join(scratch, 'project');
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(folder); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(folder, 'index.html'), '<title>local file</title><h1>FILE OK</h1>');
  fs.writeFileSync(path.join(outside, 'private.html'), '<title>private</title>');

  const opened = [];
  const origOpenExternal = shell.openExternal;
  shell.openExternal = async (url) => { opened.push(url); };

  const { server, port } = await serve((url) => `<title>page ${url}</title><body style="background:#3366cc"><h1>DEV SERVER ${url}</h1></body>`);
  // A window that is never shown has no display surface to capture; show one, unfocused, at the screen's corner.
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, x: 0, y: 0, webPreferences: { sandbox: true } });
  await win.loadURL('data:text/html,<h1>host</h1>');
  win.showInactive();
  const events = [];
  const preview = createPreview({ getWindow: () => win, getWorkspaces: () => [folder], send: (event) => events.push(event) });

  try {
    // 1. A local page loads, reports its title and can be captured.
    const opening = await preview.open(String(port), { x: 100, y: 80, width: 600, height: 400 });
    check('open_local', opening.ok === true && opening.url === `http://localhost:${port}/`, JSON.stringify(opening));
    check('title_and_url', await waitFor(() => preview.state().title === 'page /' && preview.state().url === `http://localhost:${port}/`), JSON.stringify(preview.state()));
    check('events_emitted', events.some((event) => event.type === 'preview' && event.open === true));
    const shot = await preview.capture();
    check('capture_png', shot.ok === true && /^data:image\/png;base64,/.test(shot.dataUrl) && shot.width > 100 && shot.dataUrl.length > 1000, shot.error);

    // 2. Refused: other hosts, other schemes, files outside the opened folder.
    for (const bad of ['https://example.com', 'http://169.254.169.254/', 'javascript:alert(1)', path.join(outside, 'private.html')]) {
      const refused = await preview.open(bad);
      check(`refuse_${bad.slice(0, 24)}`, refused.ok === false, JSON.stringify(refused));
    }
    check('still_on_local_page', preview.state().url === `http://localhost:${port}/`);

    // 3. A file inside the opened folder opens.
    const file = await preview.open(path.join(folder, 'index.html'));
    check('open_file_in_folder', file.ok === true && file.kind === undefined, JSON.stringify(file));
    check('file_title', await waitFor(() => preview.state().title === 'local file'), JSON.stringify(preview.state()));

    // 4. Back and forward.
    await preview.open(`http://localhost:${port}/second`);
    check('second_page', await waitFor(() => preview.state().title === 'page /second'));
    preview.back();
    check('back', await waitFor(() => preview.state().title === 'local file' && preview.state().canGoForward === true), JSON.stringify(preview.state()));
    preview.forward();
    check('forward', await waitFor(() => preview.state().title === 'page /second'));

    // 5. The page cannot take the view elsewhere; an external link goes to the browser.
    const c = win.contentView.children[0].webContents;
    await c.executeJavaScript("window.location.href = 'https://example.com/away'").catch(() => {});
    await wait(600);
    check('navigation_blocked', preview.state().url.startsWith(`http://localhost:${port}`), preview.state().url);
    check('external_goes_to_browser', opened.some((url) => url.startsWith('https://example.com')), JSON.stringify(opened));
    await c.executeJavaScript("window.open('https://example.org/popup')").catch(() => {});
    await wait(500);
    check('popup_denied_and_external', win.contentView.children.length === 1 && opened.some((url) => url.startsWith('https://example.org')), JSON.stringify(opened));
    await c.executeJavaScript(`window.open('http://localhost:${port}/popped')`).catch(() => {});
    check('local_popup_loads_in_view', await waitFor(() => preview.state().title === 'page /popped'), JSON.stringify(preview.state()));

    // 6. Bounds and visibility.
    preview.setBounds({ x: 10.4, y: 20.6, width: 300, height: 200 });
    const b = win.contentView.children[0].getBounds();
    check('bounds', b.x === 10 && b.y === 21 && b.width === 300 && b.height === 200, JSON.stringify(b));
    preview.setBounds({ x: 900, y: 600, width: 900, height: 900 });
    const clamped = win.contentView.children[0].getBounds();
    check('bounds_clamped_to_window', clamped.x + clamped.width <= 1000 && clamped.y + clamped.height <= 700, JSON.stringify(clamped));
    preview.setVisible(false);
    check('hidden', win.contentView.children[0].getVisible?.() === false || preview.state().visible === false);

    // 7. A page that is down reports an error instead of a blank view.
    server.close();
    await preview.open(`http://localhost:${port}/gone`);
    check('failed_load_reported', await waitFor(() => /ERR_|\(-\d+\)/.test(preview.state().error || '')), JSON.stringify(preview.state()));

    // 8. Close frees the view.
    preview.close();
    check('closed', win.contentView.children.length === 0 && preview.state().open === false);
  } catch (error) {
    check('no_exception', false, String(error && error.stack || error));
  } finally {
    shell.openExternal = origOpenExternal;
    try { server.close(); } catch { /* already closed */ }
    fs.rmSync(scratch, { recursive: true, force: true });
    const failed = Object.entries(results).filter(([, value]) => value !== true);
    console.log(`PREVIEW_RESULT ${JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, results })}`);
    app.exit(failed.length ? 1 : 0);
  }
});

setTimeout(() => { console.log('PREVIEW_RESULT {"error":"hard timeout"}'); app.exit(1); }, 90_000);
