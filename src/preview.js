'use strict';

/**
 * The preview: a real browser view inside the window, beside the conversation.
 *
 * The page the person's project serves (or a file in an opened folder) loads
 * in a WebContentsView of its own, so it is a top-level page: no framing
 * limits, no mixed-content or local-network gate, back and forward, developer
 * tools, and a screenshot the agent can be given. The TheOne page only draws
 * the toolbar and tells this module where the view goes.
 *
 * What it may load is decided by preview-policy.js; the view has its own
 * session (no cookies shared with TheOne), no preload, no permissions, and
 * every navigation or new window it asks for is checked again.
 */

const { WebContentsView, session, shell } = require('electron');
const { clampBounds, previewTarget } = require('./preview-policy');

const PARTITION = 'persist:theone-preview';
const MAX_CAPTURE_WIDTH = 1600;

function createPreview({ getWindow, getWorkspaces, send, log = () => {} }) {
  let view = null;
  let visible = false;
  let nav = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: '' };

  const contents = () => (view && !view.webContents.isDestroyed() ? view.webContents : null);

  function canGo(c) {
    const history = c.navigationHistory;
    return {
      canGoBack: history && typeof history.canGoBack === 'function' ? history.canGoBack() : c.canGoBack(),
      canGoForward: history && typeof history.canGoForward === 'function' ? history.canGoForward() : c.canGoForward(),
    };
  }

  function emit() {
    const c = contents();
    if (c) nav = { ...nav, url: c.getURL() || nav.url, title: c.getTitle() || nav.title, loading: c.isLoading(), ...canGo(c) };
    send({ type: 'preview', open: Boolean(c), visible, ...nav });
  }

  function allowed(url) {
    return previewTarget(url, getWorkspaces());
  }

  function ensureView() {
    if (contents()) return view;
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('No window to show the preview in.');
    const ses = session.fromPartition(PARTITION);
    // A page the person is building asks for nothing from this machine.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    view = new WebContentsView({
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    view.setBackgroundColor('#ffffff');
    view.setVisible(visible);
    win.contentView.addChildView(view);
    const c = view.webContents;

    const guard = (event, maybeUrl) => {
      const url = (event && event.url) || maybeUrl || '';
      if (allowed(url).ok) return;
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    };
    c.on('will-navigate', guard);
    c.on('will-redirect', guard);
    c.setWindowOpenHandler(({ url }) => {
      const target = allowed(url);
      if (target.ok) c.loadURL(target.url).catch(() => {});
      else if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    // A new load or a successful navigation clears an earlier failure; a failed
    // load keeps its error through the did-stop-loading that follows it.
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
      c.on(name, () => {
        if (name === 'did-start-loading' || name === 'did-navigate') nav.error = '';
        emit();
      });
    }
    c.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3: a navigation that was replaced by another, not a failure.
      if (!isMainFrame || code === -3) return;
      nav.error = `${description} (${code})`;
      nav.url = url || nav.url;
      emit();
    });
    c.on('render-process-gone', (_event, details) => { log(`preview renderer gone: ${details && details.reason}`); nav.error = 'The page crashed.'; emit(); });
    return view;
  }

  function place(rect) {
    const win = getWindow();
    if (!view || !win || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    const zoom = win.webContents.getZoomFactor ? win.webContents.getZoomFactor() : 1;
    view.setBounds(clampBounds(rect, { width, height }, zoom));
  }

  return {
    /** Load what the person typed. { ok: true, url } or { ok: false, error }. */
    async open(input, rect) {
      const target = allowed(input);
      if (!target.ok) return { ok: false, error: target.reason };
      try {
        ensureView();
        if (rect) place(rect);
        visible = true;
        view.setVisible(true);
        nav = { ...nav, url: target.url, error: '', loading: true };
        emit();
        await contents().loadURL(target.url).catch((error) => {
          // The did-fail-load handler reports it; an aborted load is the next navigation starting.
          if (!/ERR_ABORTED/.test(String(error && error.message))) log(`preview load: ${error && error.message}`);
        });
        return { ok: true, url: target.url };
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) };
      }
    },
    setBounds(rect) { place(rect); },
    setVisible(flag) {
      visible = Boolean(flag);
      if (view) view.setVisible(visible);
      emit();
    },
    reload() { const c = contents(); if (c) c.reload(); return { ok: Boolean(c) }; },
    stop() { const c = contents(); if (c) c.stop(); return { ok: Boolean(c) }; },
    back() { const c = contents(); if (c && canGo(c).canGoBack) { (c.navigationHistory ? c.navigationHistory.goBack() : c.goBack()); } return { ok: Boolean(c) }; },
    forward() { const c = contents(); if (c && canGo(c).canGoForward) { (c.navigationHistory ? c.navigationHistory.goForward() : c.goForward()); } return { ok: Boolean(c) }; },
    devtools() { const c = contents(); if (c) c.openDevTools({ mode: 'detach' }); return { ok: Boolean(c) }; },
    /** The page as an image, for the conversation (the agent can read it). */
    async capture() {
      const c = contents();
      if (!c) return { ok: false, error: 'No page is open.' };
      let image = await c.capturePage();
      const size = image.getSize();
      if (size.width > MAX_CAPTURE_WIDTH) image = image.resize({ width: MAX_CAPTURE_WIDTH });
      const final = image.getSize();
      return { ok: true, dataUrl: `data:image/png;base64,${image.toPNG().toString('base64')}`, width: final.width, height: final.height, url: c.getURL(), title: c.getTitle() };
    },
    state() {
      const c = contents();
      return { open: Boolean(c), visible, ...nav, ...(c ? { url: c.getURL() || nav.url, title: c.getTitle() || nav.title, loading: c.isLoading(), ...canGo(c) } : {}) };
    },
    /** Take the view down and free the page. */
    close() {
      const win = getWindow();
      if (view) {
        try { if (win && !win.isDestroyed()) win.contentView.removeChildView(view); } catch { /* already gone */ }
        try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* already gone */ }
      }
      view = null;
      visible = false;
      nav = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: '' };
      send({ type: 'preview', open: false, visible: false, ...nav });
    },
  };
}

module.exports = { createPreview };
