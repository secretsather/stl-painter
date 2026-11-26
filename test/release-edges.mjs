import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { fixture } from './fixture.mjs';
import { readProject, writeProject } from '../src/files.js';
import { readSTL } from '../src/mesh.js';
import { mixHex } from '../src/mixes.js';

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

test('Save, Save As and Export show the matching file type and action', async (t) => {
  const { app, page, click } = await desktop(t);
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async (_, options) => {
      global.lastSaveDialog = options;
      return { canceled: true };
    };
  });
  for (const [button, progress, title, filter, extension] of [
    ['save', 'Saving project…', 'Save painter project', 'Painter project', 'stlp'],
    ['save-as', 'Saving project as…', 'Save painter project', 'Painter project', 'stlp'],
    ['export', 'Preparing 3MF export…', 'Export 3MF', '3MF model', '3mf'],
  ]) {
    await click(button);
    assert.equal(await page.locator('#busy > :first-child').textContent(), progress);
    const options = await app.evaluate(() => global.lastSaveDialog);
    assert.equal(options.title, title);
    assert.deepEqual(options.filters, [{ name: filter, extensions: [extension] }]);
  }
});

test('a delayed title update after window destruction is harmless', async (t) => {
  const { app } = await desktop(t);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    new BrowserWindow({ show: false });
    // Replay a title notification already queued by the renderer at shutdown.
    const queued = win.listeners('page-title-updated').slice();
    win.destroy();
    if (!win.isDestroyed()) throw Error('Expected a destroyed native window.');
    for (const notify of queued) notify.call(win, { preventDefault() {} }, 'Last title');
  });
});

test('mixed colors support editable ratios, independent panels, stamp matching and project reopen', async (t) => {
  const { app, page, projectFile, dir, click } = await desktop(t);
  const rows = page.locator('#mixed-colors .swatch-row');
  const paletteToggle = page.getByRole('button', { name: 'Palette', exact: true });
  const mixedToggle = page.getByRole('button', { name: 'Mixed colors', exact: true });
  await paletteToggle.click();
  assert.ok(await page.locator('#palette').isHidden());
  assert.ok(await page.locator('#mixed-colors').isVisible());
  await paletteToggle.click();
  await click('add-mix');
  const first = page.getByRole('spinbutton', { name: 'Filament 1 percentage' });
  await first.fill('32');
  assert.ok(await page.locator('#confirm-mix').isDisabled());
  await page.getByRole('button', {name:'67/33', exact:true}).click();
  assert.equal(await first.inputValue(), '67');
  await click('confirm-mix');
  assert.match(await rows.first().innerText(), /Color 1 · 67% \+ Color 2 · 33%/);
  await mixedToggle.click();
  assert.ok(await page.locator('#mixed-colors').isHidden());
  assert.ok(await page.locator('#palette').isVisible());
  await mixedToggle.click();
  await click('add-mix');
  await page.locator('#mix-count').selectOption('3');
  assert.ok(await page.locator('#mix-presets').isHidden());
  await page.getByRole('spinbutton', {name:'Filament 3 percentage'}).fill('34');
  await click('confirm-mix');
  assert.match(await rows.nth(1).innerText(), /Color 3 · 34%/);
  await page.getByRole('button', {name:'Edit Mix 1',exact:true}).click();
  await first.fill('50');
  await click('confirm-mix');
  await click('undo');
  assert.match(await rows.first().innerText(), /67%/);
  await page.getByRole('button', { name:'Mix 1',exact:true }).click();
  await page.locator('#viewport > canvas').click();
  await click('save');
  const painted = readProject(await fs.readFile(projectFile));
  assert.ok(painted.paint.includes(4));
  await page.locator('[data-tool="Stamps"]').click();
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#385B5F';
    ctx.fillRect(0,0,3,4);
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#image-input').setInputFiles({name:'Shade.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.locator('#mapping-mode').selectOption('mix');
  await page.locator('#mapping button[value="cancel"]').first().click();
  await page.locator('#mapping').waitFor({state:'hidden'});
  assert.equal(await rows.count(),2);
  await page.locator('#image-input').setInputFiles({name:'Shade.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.locator('#mapping-mode').selectOption('mix');
  assert.match(await page.locator('#mapped-colors .swatch').first().getAttribute('title'), /\(new\)/);
  await click('confirm-import');
  await rows.nth(2).waitFor();
  assert.equal(await rows.count(),3);
  await click('undo');
  assert.equal(await rows.count(),2);
  await click('redo');
  await click('save');
  await click('open');
  assert.equal(await rows.count(),3);
  const saved = readProject(await fs.readFile(projectFile));
  assert.ok(saved.stamps[0].pixels.includes(6));
  assert.ok(saved.stamps[0].pixels.includes(255));
  await page.getByRole('button',{name:'Remove Color 1',exact:true}).click();
  assert.match(await page.locator('#remove-color-description').innerText(),/Mix 1/);
  await page.locator('#remove-color-dialog button[value="remove"]').click();
  await rows.nth(2).waitFor({state:'detached'});
  assert.ok(await rows.count() < 3);
  await click('undo');
  await click('save');
  const restored = readProject(await fs.readFile(projectFile));
  assert.deepEqual(restored.mixes, saved.mixes);
  assert.deepEqual(restored.palette, saved.palette);
  assert.deepEqual(restored.paint, saved.paint);
  assert.deepEqual(restored.stamps, saved.stamps);
  await app.evaluate(({ dialog }, output) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
  }, path.join(dir, 'Mixed.3mf'));
  await click('export');
  const { unzipSync, strFromU8 } = await import('fflate');
  const archive = unzipSync(new Uint8Array(await fs.readFile(path.join(dir, 'Mixed.3mf'))));
  const settings = JSON.parse(strFromU8(archive['Metadata/project_settings.config']));
  assert.deepEqual(settings.filament_colour, saved.palette.slice(0,4));
  assert.match(settings.mixed_filament_definitions, /^1,2,1,1,33,/);
  assert.match(strFromU8(archive['3D/3dmodel.model']), /paint_color="[^"]*2C/);
});

test('scrolling mixed-color rows contain the full recipe at default and minimum sidebar widths', async (t) => {
  const { page, click, projectFile } = await desktop(t);
  const project = readSTL(fixture(), 'Mixed rows.stl');
  project.mixes = {};
  for (const weights of [[50,50],[33,67],[67,33],[40,60],[60,40],[55,45],[34,33,33]]) {
    const parts = weights.map((percent, slot) => ({slot, percent}));
    project.mixes[project.palette.length] = parts;
    project.palette.push(mixHex(project.palette, parts));
  }
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  const list = page.locator('#mixed-colors');
  const last = list.getByRole('button', {name:'Mix 7',exact:true});
  await last.click();
  for (const narrow of [false, true]) {
    if (narrow) {
      const divider = page.locator('#sidebar-divider');
      for (let i = 0; i < 20; i++) await divider.press('ArrowRight');
      assert.equal(await divider.getAttribute('aria-valuenow'), '240');
    }
    await last.scrollIntoViewIfNeeded();
    assert.equal(await last.getAttribute('aria-pressed'), 'true');
    const fit = await list.evaluate(el => {
      if (el.scrollTop <= 0 || el.scrollWidth > el.clientWidth) return false;
      return [...el.children].every(row => {
        const bounds = row.getBoundingClientRect();
        const button = row.querySelector('.mix-choice');
        const heading = button.querySelector('.mix-heading').getBoundingClientRect();
        const recipe = button.querySelector('small').getBoundingClientRect();
        const remove = row.querySelector('.remove-entry').getBoundingClientRect();
        return bounds.top <= heading.top && heading.bottom <= recipe.top &&
          [...button.querySelectorAll('small span')].every(span => {
            const box = span.getBoundingClientRect();
            return box.bottom <= bounds.bottom && box.right <= remove.left;
          });
      });
    });
    assert.ok(fit, 'each recipe stays below its heading and inside its row');
  }
  await list.getByRole('button',{name:'Edit Mix 7',exact:true}).click();
  assert.equal(await page.locator('#mix-count').inputValue(), '3');
});

test('mix suggestions cover each physical pair and trio and only save on confirmation', async (t) => {
  const { page, click, projectFile } = await desktop(t);
  await click('add-mix');
  const gallery = page.locator('#mix-suggestions');
  const groups = gallery.locator('.mix-group');
  const shares = page.locator('#mix-parts input');
  async function verify(expectedGroups, ratios) {
    const shown = await groups.evaluateAll(nodes => nodes.map(node => ({
      sources: [...node.querySelectorAll('.mix-sources span')].map(s => s.textContent).join('+'),
      ratios: [...node.querySelectorAll('button')].map(b => b.textContent),
    })));
    assert.deepEqual(shown, expectedGroups.map(ids => ({
      sources: ids.map(i => 'Color ' + i).join('+'), ratios,
    })));
  }
  await verify([[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]], ['50/50','33/67','67/33']);
  const pair = groups.nth(4).getByRole('button').nth(1);
  await pair.click();
  assert.equal(await pair.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await shares.evaluateAll(nodes => nodes.map(n => n.valueAsNumber)), [33,67]);
  await shares.first().fill('45');
  assert.equal(await gallery.locator('[aria-pressed=true]').count(), 0);
  await page.locator('#mix-count').selectOption('3');
  await verify([[1,2,3],[1,2,4],[1,3,4],[2,3,4]], ['33/33/34','33/34/33','34/33/33']);
  const trio = groups.last().getByRole('button').nth(1);
  await trio.click();
  const title = await trio.getAttribute('title');
  assert.ok((await page.locator('#mix-preview').innerText()).includes(title.slice(-7)));
  await page.locator('#mix-editor button[value=cancel]').click();
  assert.equal(await page.locator('#mixed-colors .swatch-row').count(), 0);
  await click('add-mix');
  await page.locator('#mix-count').selectOption('3');
  await trio.click();
  await click('confirm-mix');
  await click('save');
  const saved = readProject(await fs.readFile(projectFile));
  assert.deepEqual(saved.mixes[4], [{slot:1,percent:33},{slot:2,percent:34},{slot:3,percent:33}]);
  await click('add-color');
  await click('add-mix');
  assert.equal(await groups.count(), 10); // Five physical filaments, plus one saved mix.
  await page.locator('#mix-count').selectOption('3');
  assert.equal(await groups.count(), 10);
  assert.ok(await gallery.getByRole('button', {name:title + ' (already in palette)',exact:true}).isDisabled());
  await page.locator('#mix-editor button[value=cancel]').click();
  await page.getByRole('button',{name:'Edit Mix 1',exact:true}).click();
  const current = gallery.getByRole('button',{name:title,exact:true});
  assert.equal(await current.getAttribute('aria-pressed'), 'true');
  assert.ok(await current.isEnabled());
});

test('beige and white use a calibrated preview, reuse the cream spool for a stamp and suggest charcoal', async (t) => {
  const { page, projectFile, click } = await desktop(t);
  const project = readSTL(fixture(), 'Four spools.stl');
  project.palette = ['#E7DDC8','#FFFFFF','#00C1AE','#F4E2C1'];
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await click('add-color');
  assert.equal(await page.locator('#palette .palette-hex').last().innerText(), '#242629');
  await click('undo');
  await click('add-mix');
  assert.match(await page.locator('#mix-preview').innerText(), /#F1E3C0/);
  await click('confirm-mix');
  await page.locator('[data-tool="Stamps"]').click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F1E3C0';
    ctx.fillRect(0, 0, 2, 2);
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#image-input').setInputFiles({name:'Cream.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.locator('#mapping-mode').selectOption('mix');
  assert.equal(await page.locator('#mapped-colors .swatch').getAttribute('title'), '#F4E2C1');
  await click('confirm-import');
  await click('save');
  const saved = readProject(await fs.readFile(projectFile));
  assert.deepEqual(saved.palette, [...project.palette, '#F1E3C0']);
  assert.deepEqual([...saved.stamps[0].pixels], [3,3,3,3]);
});

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
  const before = readProject(saved), after = readProject(await fs.readFile(projectFile));
  // OrbitControls recomputes eye coordinates from spherical angles on reopen.
  for (const { editingContext } of [before, after]) {
    editingContext.camera.position = editingContext.camera.position.map(n => Number(n.toFixed(10)));
  }
  assert.deepEqual(after, before);
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
  const { editingContext, ...model } = readProject(await fs.readFile(projectFile));
  assert.equal(editingContext.tool, 'Brush');
  assert.deepEqual(model, readSTL(slab, path.basename(file)));
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
