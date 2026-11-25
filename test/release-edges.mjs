import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { fixture } from './fixture.mjs';
import { readProject, writeProject } from '../src/files.js';
import { readSTL } from '../src/mesh.js';

async function desktop(t, dir) {
  dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'stl-painter-release-'));
  const projectFile = path.join(dir, 'Test project.stlp');
  const executablePath = process.env.PAINTER_EXE;
  const app = await _electron.launch({
    executablePath,
    args: [...(executablePath ? [] : ['.']), '--user-data-dir=' + path.join(dir, 'profile')],
  });
  t.after(async () => {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  });
  const page = await app.firstWindow();
  await page.locator('#faces').filter({ hasText: 'source triangles' }).waitFor();
  await app.evaluate(({ dialog }, file) => {
    global.openFixture = file;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [global.openFixture] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, projectFile);
  async function click(id) {
    await page.locator('#' + id).click();
    await page.locator('#busy').waitFor({ state: 'hidden' });
  }
  return { app, page, dir, projectFile, click };
}

test('stroke refinement starts enabled on launch and on opening a model', async (t) => {
  const first = await desktop(t);
  const checkbox = (page) => page.getByRole('checkbox', { name: 'Refine stroke edges' });
  assert.ok(await checkbox(first.page).isChecked(), 'fresh profile');
  await checkbox(first.page).uncheck();
  await first.page.locator('[data-tool="Eraser"]').click();
  assert.equal(await checkbox(first.page).isChecked(), false, 'Brush and Eraser share the override');
  await first.page.evaluate(() => localStorage.setItem('refineStrokeEdges', 'off'));
  await first.app.close();

  const next = await desktop(t, first.dir);
  assert.ok(await checkbox(next.page).isChecked(), 'relaunch with a legacy off preference');
  await next.click('save');
  await checkbox(next.page).uncheck();
  await next.click('open');
  assert.ok(await checkbox(next.page).isChecked(), 'reopened project');
  const stl = path.join(next.dir, 'Slab.stl');
  await fs.writeFile(stl, fixture());
  await next.app.evaluate((_, file) => { global.openFixture = file; }, stl);
  await checkbox(next.page).uncheck();
  await next.click('open');
  assert.ok(await checkbox(next.page).isChecked(), 'imported STL');
});

test('saving when reopening the same project keeps the latest edits in memory and on disk', async (t) => {
  const { page, projectFile, click } = await desktop(t);
  const rows = page.locator('.swatch-row');
  await click('save');
  await click('add-color');
  const edited = await rows.count();
  await click('open');
  const onDisk = async () => readProject(await fs.readFile(projectFile)).palette.length;
  const afterPrompt = await onDisk();
  const displayed = await rows.count();
  await click('save');
  assert.deepEqual([afterPrompt, displayed, await onDisk()], [edited, edited, edited]);
});

test('reopening after a first save into the selected project loads the new contents', async (t) => {
  const { page, projectFile, click } = await desktop(t);
  const old = readSTL(fixture(), 'Old slab.stl');
  await fs.writeFile(projectFile, writeProject(old));
  const current = await page.locator('#model-name').innerText();
  await click('add-color');
  await click('open');
  assert.equal(await page.locator('#model-name').innerText(), current);
  assert.equal(await page.locator('.swatch-row').count(), 5);
  assert.ok(await page.locator('#dirty').isHidden());
  const saved = await fs.readFile(projectFile);
  assert.equal(readProject(saved).name, current);
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)), readProject(saved));
});

test('reopening a different same-named project saves edits to the original and switches destinations', async (t) => {
  const { app, page, dir, projectFile, click } = await desktop(t);
  await click('save');
  await click('add-color');
  const folder = path.join(dir, 'other');
  await fs.mkdir(folder);
  const other = path.join(folder, path.basename(projectFile));
  await fs.writeFile(other, writeProject(readSTL(fixture(), 'Other slab.stl')));
  await app.evaluate((_, file) => { global.openFixture = file; }, other);
  await click('open');
  assert.equal(await page.locator('#model-name').innerText(), 'Other slab');
  assert.equal(readProject(await fs.readFile(projectFile)).palette.length, 5);
  await click('add-color');
  await click('add-color');
  await click('save');
  assert.equal(readProject(await fs.readFile(other)).palette.length, 6);
  assert.equal(readProject(await fs.readFile(projectFile)).palette.length, 5);
});

test('reopening honors canceled saves, Cancel, and Discard', async (t) => {
  const { app, page, projectFile, click } = await desktop(t);
  const original = writeProject(readSTL(fixture(), 'Saved slab.stl'));
  await fs.writeFile(projectFile, original);
  await click('add-color');
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await click('open');
  assert.equal(await page.locator('.swatch-row').count(), 5);
  assert.ok(await page.locator('#dirty').isVisible());
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2 }); });
  await click('open');
  assert.equal(await page.locator('.swatch-row').count(), 5);
  assert.ok(await page.locator('#dirty').isVisible());
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await click('open');
  assert.equal(await page.locator('#model-name').innerText(), 'Saved slab');
  assert.ok(await page.locator('#dirty').isHidden());
  assert.ok((await fs.readFile(projectFile)).equals(original));
});

test('a discarded zero-area STL facet does not enlarge the usable model bounds', async (t) => {
  const { app, page, click, dir, projectFile } = await desktop(t);
  const slab = fixture();
  const bytes = Buffer.concat([slab, Buffer.alloc(50)]);
  bytes.writeUInt32LE(slab.readUInt32LE(80) + 1, 80);
  for (let corner = 0; corner < 3; corner++) bytes.writeFloatLE(10000, slab.length + 12 + corner * 12);
  const file = path.join(dir, 'Slab with one degenerate facet.stl');
  await fs.writeFile(file, bytes);
  await app.evaluate((_, file) => { global.openFixture = file; }, file);
  await click('open');
  assert.equal(await page.locator('#dimensions').textContent(), '95 × 52 × 12 mm');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)), readSTL(slab, path.basename(file)));
});

test('large models warn above one million, open through 1.5 million, and reject larger files', async (t) => {
  const { app, page, click, dir, projectFile } = await desktop(t);
  const file = path.join(dir, 'Threshold grid.stl');
  const buffer = Buffer.alloc(84 + 50 * 1_500_001);
  for (let i = 0; i < 1_500_001; i++) {
    const x = Math.floor(i / 2) % 1000, y = Math.floor(i / 2000);
    const corners = i % 2 ? [x + 1, y, x + 1, y + 1, x, y + 1] : [x, y, x + 1, y, x, y + 1];
    for (let j = 0; j < 3; j++) {
      const start = 96 + i * 50 + j * 12;
      buffer.writeFloatLE(corners[2 * j], start);
      buffer.writeFloatLE(corners[2 * j + 1], start + 4);
    }
  }
  t.after(() => fs.unlink(file));
  async function writeGrid(count) {
    buffer.writeUInt32LE(count, 80);
    await fs.writeFile(file, buffer.subarray(0, 84 + count * 50));
  }
  await app.evaluate(({ dialog }, file) => {
    global.openFixture = file;
    global.warnings = [];
    global.cancelLarge = true;
    dialog.showMessageBox = async (_, options) => {
      if (options.type !== 'warning') return { response: 1 }; // Discard edits when explicitly opening.
      global.warnings.push(options.detail);
      return { response: global.cancelLarge ? 1 : 0 };
    };
  }, file);
  const warnings = () => app.evaluate(() => global.warnings);
  await writeGrid(1_000_000);
  await click('open');
  assert.equal(await page.locator('#faces').innerText(), '1,000,000 source triangles');
  assert.deepEqual(await warnings(), []);
  await click('add-color');
  await writeGrid(1_000_001);
  await click('open');
  assert.match((await warnings())[0], /1,000,001 source triangles/);
  assert.ok(await page.locator('#dirty').isVisible());
  assert.equal(await page.locator('#faces').innerText(), '1,000,000 source triangles');
  await app.evaluate(() => { global.cancelLarge = false; });
  await writeGrid(1_500_000);
  await click('open');
  assert.equal(await page.locator('#faces').innerText(), '1,500,000 source triangles');
  await click('save');
  const saved = readProject(await fs.readFile(projectFile));
  assert.equal(saved.depth.length, 1_500_000);
  assert.ok(saved.paint.length <= 1_600_000);
  await app.evaluate((_, dest) => { global.openFixture = dest; }, projectFile);
  await click('open');
  assert.equal(await page.locator('#model-kind').innerText(), 'PAINTER PROJECT');
  assert.equal((await warnings()).length, 3);
  await writeGrid(1_500_001);
  await app.evaluate((_, dest) => { global.openFixture = dest; }, file);
  await click('open');
  assert.match(await page.locator('#notice-text').innerText(), /1,500,000 source triangle limit/);
  assert.equal((await warnings()).length, 3);
  assert.equal(await page.locator('#model-kind').innerText(), 'PAINTER PROJECT');
});

test('a rotated stamp stops at the viewport edge during drag, release and reselection', async (t) => {
  const { app, page, click } = await desktop(t);
  await page.locator('[data-tool="Stamps"]').click();
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    c.getContext('2d').fillRect(0, 0, 8, 8);
    return c.toDataURL().split(',')[1];
  });
  await page.locator('#image-input').setInputFiles({ name: 'Square.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await click('confirm-import');
  const outline = page.locator('#stamp-outline');
  await outline.waitFor();
  await page.locator('#rotation').evaluate((slider) => {
    slider.value = '37';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const viewport = await page.locator('#viewport').boundingBox();
  const sidebar = await page.locator('aside').boundingBox();
  const y = viewport.y + viewport.height / 2;
  // Ignore physical mouse movements while Playwright drives the captured drag.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true));
  await page.mouse.move(viewport.x + viewport.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(sidebar.x + sidebar.width * 0.75, y, { steps: 8 });
  async function atRightEdge() {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await outline.boundingBox();
    assert.ok(Math.abs(box.x + box.width - (viewport.x + viewport.width)) < 1);
    assert.ok(Math.abs(box.y + box.height / 2 - y) < 1);
  }
  await atRightEdge();
  await page.mouse.up();
  await atRightEdge();
  await page.locator('.stamp-choice').click();
  await atRightEdge();
});
