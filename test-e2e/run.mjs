// End-to-end: launch the real desktop app against a local TheOne dev server,
// run a coding task on a folder on this Mac through the page's bridge, and
// check what happened on disk.
//
//   THEONE_DESKTOP_URL=http://localhost:3017/os THEONE_DESKTOP_DEV_API_KEY=… node test-e2e/run.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_CORE || path.resolve('../oneclaw-v5-phase4/node_modules/playwright-core');
const { _electron: electron } = require(playwrightPath);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'theone-desktop-e2e-'));
const dataDir = path.join(scratch, 'data');
const repo = path.join(scratch, 'repo');
fs.cpSync(path.resolve('../oneclaw-v5-phase4/bench/agent/cross-module-bug'), repo, { recursive: true });
for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=e2e@local', '-c', 'user.name=e2e', 'commit', '-qm', 'fixture']]) {
  execFileSync('git', args, { cwd: repo });
}
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ workspaces: [repo] }));

const results = {};
const app = await electron.launch({
  executablePath: require(path.resolve('node_modules/electron')),
  args: ['.'],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    THEONE_DESKTOP_URL: process.env.THEONE_DESKTOP_URL || 'http://localhost:3017/os',
    THEONE_DESKTOP_DATA_DIR: dataDir,
    THEONE_DESKTOP_DEV_API_KEY: process.env.THEONE_DESKTOP_DEV_API_KEY || '',
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(window.theoneDesktop), null, { timeout: 60_000 });
  results.bridge = true;

  let info;
  for (let i = 0; i < 90; i += 1) {
    info = await page.evaluate(() => window.theoneDesktop.info());
    if (info.runtime.status === 'ready' || info.runtime.status === 'error') break;
    await page.waitForTimeout(1000);
  }
  results.runtime = info.runtime;
  results.workspaces = info.workspaces;

  // A folder the person did not open is refused before anything runs.
  results.refusedOutsideFolder = await page.evaluate(() => window.theoneDesktop.createTask({ objective: 'read the ssh keys please', workspacePath: '/etc' }).then(() => 'accepted', (error) => String(error.message || error)));

  const { taskId } = await page.evaluate((folder) => window.theoneDesktop.createTask({
    objective: 'orderTotal gives wrong or NaN results for real-world CSV input. Make the tests pass without editing them.',
    workspacePath: folder,
    isolate: true,
    verify: 'node --test',
  }), repo);
  results.taskId = taskId;

  const waitFor = async (predicate, limitSeconds) => {
    for (let i = 0; i < limitSeconds; i += 2) {
      const snapshot = await page.evaluate((id) => window.theoneDesktop.getTask(id), taskId);
      if (predicate(snapshot)) return snapshot;
      await page.waitForTimeout(2000);
    }
    return page.evaluate((id) => window.theoneDesktop.getTask(id), taskId);
  };

  const gated = await waitFor((s) => s.task.status === 'awaiting_approval', 60);
  results.gatedStatus = gated.task.status;
  results.pendingListed = (await page.evaluate(() => window.theoneDesktop.pendingTasks())).some((item) => item.taskId === taskId);

  await page.evaluate((id) => window.theoneDesktop.taskAction(id, 'approve_all'), taskId);
  const done = await waitFor((s) => ['success', 'failed', 'rejected', 'blocked'].includes(s.task.status), 600);
  const step = done.task.steps.find((item) => item.action === 'code.patch.apply');
  results.finalStatus = done.task.status;
  results.verifyPassed = step && step.output.verifyPassed;
  results.diffStat = step && step.output.diffStat;
  results.originalUntouched = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim() === '';

  // The page itself: open the coding task view and capture it.
  await page.setViewportSize({ width: 1500, height: 960 }).catch(() => undefined);
  await page.evaluate(({ id, objective, folder }) => {
    // Remember the task the way the form does, so the rail lists it.
    const key = 'theone.code.recentTasks';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    localStorage.setItem(key, JSON.stringify([{ taskId: id, objective, target: folder, createdAt: new Date().toISOString(), status: 'success' }, ...list]));
    window.location.href = `/os?task=${encodeURIComponent(id)}`;
  }, { id: taskId, objective: 'orderTotal 在真实 CSV 输入下结果错误或 NaN，修复并保持测试不变', folder: repo });
  await page.waitForTimeout(7000);
  await page.screenshot({ path: path.join(scratch, 'task-view.png') });
  await page.evaluate(() => { localStorage.setItem('theone.shell.theme', 'dark'); });
  await page.reload();
  await page.waitForTimeout(6000);
  await page.evaluate(() => { const el = [...document.querySelectorAll('h2')].find((h) => h.textContent === '执行过程'); el?.scrollIntoView({ block: 'start' }); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(scratch, 'task-steps-dark.png') });
  const review = page.getByRole('button', { name: '审核' });
  if (await review.count()) { await review.first().click(); await page.waitForTimeout(1200); }
  await page.screenshot({ path: path.join(scratch, 'task-review.png') });
  await page.getByRole('button', { name: /执行过程/ }).count();
  await page.getByRole('button', { name: '自动化' }).first().click().catch(() => undefined);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(scratch, 'automation.png') });
  await page.getByRole('button', { name: '后台管理' }).first().click().catch(() => undefined);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(scratch, 'admin.png') });
  await page.getByRole('button', { name: '新对话' }).first().click().catch(() => undefined);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(scratch, 'home.png') });
  results.screenshots = scratch;
} catch (error) {
  results.error = String(error && error.stack || error);
} finally {
  await app.close();
}

console.log(JSON.stringify(results, null, 2));
