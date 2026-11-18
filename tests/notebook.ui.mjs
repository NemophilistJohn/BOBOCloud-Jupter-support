import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const host = path.resolve(process.env.BOBOCLOUD_HOST_CLIENT || path.join(root, '..', 'my-electron-app', 'client'));
const archive = path.join(root, 'artifacts', 'bobocloud.notebook-preview-1.0.0.boboplugin');
const general = path.resolve(process.env.BOBOCLOUD_GENERAL_PREVIEW_ARTIFACT || path.join(
  root, '..', 'bobocloud-document-preview', 'artifacts', 'bobocloud.document-preview-1.1.1.boboplugin'
));
const id = 'bobocloud.notebook-preview';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+6iioAAAAASUVORK5CYII=';

function notebook() {
  return JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' }, vendor_extra: { preserved: true } },
    cells: [
      { cell_type: 'markdown', source: ['# Regression notes\n\n', 'The loss is $x^2$.\n\n',
        '$$\n\\frac{1}{2}\n$$\n\n', '![attached](attachment:plot.png)\n\n',
        '![External](https://example.test/remote.png)\n\n<script>document.body.dataset.ran = "yes"</script>'],
      metadata: {}, attachments: { 'plot.png': { 'image/png': png } } },
      { cell_type: 'code', source: ['print("saved, not executed")'], execution_count: 7, metadata: { unfamiliar: { option: 1 } },
        outputs: [
          { output_type: 'stream', name: 'stdout', text: 'Unique metric 0.82\n' },
          { output_type: 'error', ename: 'ValueError', traceback: ['\x1b[31mValueError: fixture\x1b[0m'] },
          { output_type: 'display_data', data: { 'text/html':
            '<table><tr><th>Metric</th><td>Table Value</td></tr></table><script>document.body.dataset.ran="yes"</script><img src="https://example.test/image.png">' } },
          { output_type: 'display_data', data: { 'image/png': png, 'text/plain': 'plot' } },
          { output_type: 'display_data', data: { 'text/latex': '\\sqrt{4}' } },
          { output_type: 'display_data', data: { 'application/vnd.jupyter.widget-view+json': { model_id: 'fixture' } } }
        ] },
      ...Array.from({ length: 25 }, (_, index) => ({ cell_type: 'raw', metadata: {}, source: 'Appendix ' + index }))
    ]
  }, null, 2).replace(/\n/g, '\r\n') + '\r\n';
}

test('real Electron installs, renders, localizes and disposes the isolated notebook viewer', { timeout: 120_000 }, async (t) => {
  const hostRequire = createRequire(path.join(host, 'package.json'));
  const { _electron: electron, expect } = hostRequire('playwright/test');
  const { createPluginController } = hostRequire('./main/plugins.js');
  const base = path.resolve(os.tmpdir());
  const sandbox = await mkdtemp(path.join(base, 'bobo-notebook-preview-'));
  let app;
  t.after(async () => {
    if (app) {
      try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch {}
      await app.close().catch(() => {});
    }
    assert.equal(path.dirname(sandbox), base);
    assert.ok(path.basename(sandbox).startsWith('bobo-notebook-preview-'));
    await rm(sandbox, { recursive: true, force: true, maxRetries: 18, retryDelay: 150 });
  });
  const workspace = path.join(sandbox, 'workspace');
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  await Promise.all([workspace, appData, home, path.join(root, 'test-results')].map((directory) => mkdir(directory, { recursive: true })));
  const raw = notebook();
  const broken = '{this is not a JSON document}';
  await writeFile(path.join(workspace, 'analysis.ipynb'), raw);
  await writeFile(path.join(workspace, 'broken.ipynb'), broken);
  await writeFile(path.join(workspace, 'empty.ipynb'), '{"nbformat":4,"cells":[]}');

  app = await electron.launch({
    executablePath: path.join(host, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    cwd: host,
    args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
    env: { ...process.env, APPDATA: appData, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config'), BOBO_FORCE_FIRST_RUN: '0', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  });
  const page = await app.firstWindow();
  const requests = [];
  page.on('request', (request) => { if (request.url().startsWith('https://example.test/')) requests.push(request.url()); });
  await page.waitForFunction(() => !!window.BOBO?.documentViews && document.documentElement.dataset.boboReady === 'true', null, { timeout: 25_000 });
  await page.evaluate(async (folder) => {
    await window.BOBO.i18n.setLocale('en');
    const opened = await window.api.pickWorkspace(folder);
    await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
  }, workspace);
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const installer = createPluginController({
    app: { getPath: () => userData, getVersion: () => '2.8.1' },
    ipcMain: { handle() {} }, getWindow: () => null,
    getWorkspaceIdentity: () => ({ rootPath: workspace, workspaceIdentity: 1 }), hostVersion: '2.8.1'
  });
  const generalId = 'bobocloud.document-preview';
  await installer.installArchiveFromPath(general);
  const installed = await installer.installArchiveFromPath(archive);
  assert.equal(installed.id, id);
  assert.equal(installed.status, 'disabled');
  await page.evaluate(async (pluginIds) => {
    await window.api.plugins.refresh();
    for (const pluginId of pluginIds) await window.api.plugins.enable(pluginId);
  }, [generalId, id]);
  const viewer = () => page.evaluate(() => window.BOBO.documentViews.find('analysis.ipynb')?.pluginId);
  await expect.poll(viewer).toBe(id);
  const activity = page.locator('.source-control-activity');
  await expect(activity).toHaveCount(1);
  await activity.click();
  const panel = page.locator('.source-control-sidebar.active');
  await expect(panel.locator('.source-control-heading')).toHaveText('Notebook');
  await expect(panel).toContainText('.ipynb');
  await expect(panel).toContainText('Read only');

  async function open(name) {
    await page.evaluate(({ file, name }) => window.BOBO.workspace.openFile(file, name), { file: path.join(workspace, name), name });
    const frame = page.locator('#document-view-host iframe.document-view-frame:not([hidden])').last();
    await expect(frame).toBeVisible({ timeout: 20_000 });
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
    return frame.contentFrame();
  }
  const view = await open('analysis.ipynb');
  await expect(view.getByRole('heading', { name: 'Regression notes' })).toBeVisible();
  assert.deepEqual(await view.locator('body').evaluate(() => [typeof window.api, typeof window.BOBO, location.origin]), ['undefined', 'undefined', 'null']);
  await expect(view.locator('math')).toHaveCount(3);
  await expect(view.locator('mfrac')).toHaveCount(1);
  await expect(view.locator('.nb-cells table')).toContainText('Table Value');
  await expect(view.locator('.nb-error')).toHaveText('ValueError: fixture');
  await expect(view.getByText('No supported static representation.', { exact: true })).toBeVisible();
  assert.equal(await view.locator('.nb-rich script,.nb-rich iframe,.nb-rich a,.nb-rich [onerror]').count(), 0);
  assert.equal(await view.locator('body').getAttribute('data-ran'), null);
  for (const image of [view.getByAltText('attached'), view.getByAltText('Saved image')]) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((img) => img.naturalWidth)).toBe(1);
  }
  assert.deepEqual(requests, []);
  assert.equal(await view.locator('.nb-cell').count(), 24);
  await view.getByRole('button', { name: 'Next page' }).click();
  await expect(view.locator('.nb-cell')).toHaveCount(3);
  await view.getByRole('button', { name: 'Previous page' }).click();

  await view.getByRole('button', { name: 'Collapse cells on this page' }).click();
  await expect(view.locator('.nb-cell[open]')).toHaveCount(0);
  await view.getByRole('button', { name: '01 Regression notes' }).or(view.getByRole('button', { name: '1 Regression notes' })).click();
  await expect(view.locator('.nb-cell[open]')).toHaveCount(1);
  await view.getByRole('button', { name: 'Expand cells on this page' }).click();
  await expect(view.locator('.nb-cell[open]')).toHaveCount(24);
  const search = view.getByRole('searchbox', { name: 'Search cells and text outputs' });
  await search.fill('UNIQUE METRIC');
  await expect(view.locator('.nb-cell')).toHaveCount(1);
  await expect(view.getByText('Unique metric 0.82', { exact: true })).toBeVisible();
  await search.fill('missing needle');
  await expect(view.getByText('No cells match this search.')).toBeVisible();
  await search.fill('');
  await expect(view.locator('.nb-cell')).toHaveCount(24);

  await view.getByRole('button', { name: 'Original JSON' }).click();
  assert.equal(await view.locator('.nb-json').textContent(), raw);
  await view.getByRole('button', { name: 'Notebook preview' }).click();
  await expect(view.getByRole('heading', { name: 'Regression notes' })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'test-results', 'notebook-preview.png') });

  await page.evaluate(() => window.BOBO.i18n.setLocale('zh-CN'));
  await expect(view.getByRole('button', { name: '原始 JSON' })).toBeVisible();
  await expect(panel).toContainText('只读');
  await page.evaluate(() => window.BOBO.i18n.setLocale('ja'));
  await expect(view.getByRole('button', { name: '元の JSON' })).toBeVisible();
  await expect(panel).toContainText('読み取り専用');
  await page.evaluate(() => window.BOBO.i18n.setLocale('en'));

  const invalid = await open('broken.ipynb');
  await expect(invalid.getByText('This file is not valid JSON.')).toBeVisible();
  await invalid.getByRole('button', { name: 'Original JSON' }).click();
  assert.equal(await invalid.locator('.nb-json').textContent(), broken);
  const empty = await open('empty.ipynb');
  await expect(empty.getByText('This notebook has no cells.')).toBeVisible();

  await page.evaluate((pluginId) => window.api.plugins.disable(pluginId), id);
  await expect(activity).toHaveCount(0);
  await expect.poll(viewer).toBe(generalId);
  assert.equal(await readFile(path.join(workspace, 'analysis.ipynb'), 'utf8'), raw);
});
