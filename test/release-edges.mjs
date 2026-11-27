import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { fixture, gapGrid, gapWedge } from './fixture.mjs';
import { readProject, writeProject } from '../src/files.js';
import { makeSurface, readSTL } from '../src/mesh.js';
import { mixHex } from '../src/mixes.js';
import { applyLeafEdits } from '../src/paint-tree.js';

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

test('brush release and lasso Apply merge nested paint into the selected mix in one undo step', async t => {
  const { click, page, projectFile } = await desktop(t);
  const project = gapGrid(32, 32, 1);
  project.mixes = {4: [{slot: 1, percent: 50}, {slot: 2, percent: 50}]};
  project.palette.push(mixHex(project.palette, project.mixes[4]));
  project.paint.fill(4);
  const uniform = project.paint.slice(), center = 2 * (16 * 32 + 16);
  Object.assign(project, applyLeafEdits(project, new Map([[center,
    {side: 2, left: 4, right: {side: 3, left: 1, right: 4}}]])));
  project.editingContext = {color: project.palette[4]};
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  const checkCounts = async paintCount => {
    assert.equal(await page.locator('#faces').innerText(), project.depth.length.toLocaleString() + ' source triangles');
    assert.equal(await page.locator('#paint-triangles').innerText(), paintCount.toLocaleString() + ' / 2,000,000 paint triangles');
  };
  await checkCounts(project.paint.length);
  await page.locator('#view').selectOption('Top');
  const rect = await page.locator('#viewport > canvas').boundingBox();
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  const snapshot = async () => {
    await click('save');
    return readProject(await fs.readFile(projectFile));
  };
  for (const mode of ['plain brush', 'refined brush', 'lasso']) {
    if (mode === 'lasso') {
      await page.locator('[data-tool="Fill Lasso"]').click();
      for (const [dx,dy] of [[-60,-60],[60,-60],[60,60],[-60,60],[-60,-60]])
        await page.mouse.click(x + dx, y + dy);
      assert.deepEqual((await snapshot()).splits, project.splits, 'preview preserves saved splits');
      await checkCounts(project.paint.length);
      await click('apply-lasso');
    } else {
      await page.locator('#refine-edges').setChecked(mode === 'refined brush');
      await page.locator('#brush-size').press('End');
      await page.mouse.click(x, y);
    }
    const merged = await snapshot();
    await checkCounts(uniform.length);
    assert.deepEqual(merged.paint, uniform, mode);
    assert.equal(merged.splits, undefined, mode);
    await click('undo');
    const restored = await snapshot();
    await checkCounts(project.paint.length);
    assert.deepEqual(restored.splits, project.splits);
    assert.deepEqual(restored.paint, project.paint);
    assert.ok(await page.locator('#undo').isDisabled());
    await click('redo');
    await checkCounts(uniform.length);
    assert.deepEqual((await snapshot()).paint, uniform);
    await click('undo');
  }
});

test('Fill Lasso uses toolbar icons, locks the view, previews and applies one visible-surface edit', async t => {
  const { page, click, projectFile } = await desktop(t);
  const project = gapGrid(6, 6, 10), topFaces = project.paint.length;
  const below = project.vertices.map((n, i) => i % 3 === 2 ? n - 4 : n);
  const offset = project.vertices.length / 3;
  project.vertices = Float32Array.from([...project.vertices, ...below]);
  project.faces = Uint32Array.from([...project.faces, ...project.faces.map(n => n + offset)]);
  project.depth = new Uint8Array(topFaces * 2);
  project.paint = new Uint8Array(topFaces * 2);
  project.paint[42] = 2;
  project.mixes = {4: [{slot: 1, percent: 50}, {slot: 2, percent: 50}]};
  project.palette.push(mixHex(project.palette, project.mixes[4]));
  project.editingContext = { lockedSlots: [2], color: project.palette[4] };
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.locator('#view').selectOption('Top');
  await page.locator('#viewport > canvas').focus();
  await page.keyboard.press('l');
  const outline = page.locator('#lasso-curve'), apply = page.locator('#apply-lasso');
  const toolIcons = page.locator('.toolrail [data-tool] svg');
  assert.deepEqual(await page.locator('#tool-shortcuts svg').evaluateAll(icons => icons.map(i => i.innerHTML)),
    await toolIcons.evaluateAll(icons => icons.map(i => i.innerHTML)));
  assert.equal(await page.locator('#tool-key').innerText(), 'L');
  const rect = await page.locator('#viewport > canvas').boundingBox();
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  async function camera() {
    await click('save');
    return readProject(await fs.readFile(projectFile)).editingContext.camera;
  }
  async function navigate(button) {
    await page.mouse.move(cx, cy);
    await page.mouse.down({button});
    await page.mouse.move(cx + 45, cy + 25, {steps: 3});
    await page.mouse.up({button});
  }
  assert.ok(await page.locator('#fit').isEnabled());
  const initial = await camera();
  await navigate('right');
  const orbited = await camera();
  assert.notDeepEqual(orbited.position, initial.position);
  await navigate('middle');
  const panned = await camera();
  assert.notDeepEqual(panned.target, orbited.target);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -140);
  assert.notDeepEqual(await camera(), panned);
  await click('fit');
  await page.locator('#view').selectOption('Top');
  const nodes = page.locator('#lasso-outline circle');
  async function draw() {
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await page.mouse.click(rect.x + 8, y);
    assert.ok(await page.locator('#fit').isDisabled());
    assert.equal(await nodes.count(), 1);
    await page.mouse.move(x - 60, y - 60);
    await page.mouse.down();
    await page.mouse.move(x + 25, y - 10, {steps: 5});
    await page.mouse.up();
    assert.equal(await nodes.count(), 2, 'dragging and releasing adds only the clicked node');
    await page.mouse.click(rect.x + 8, y);
    assert.equal(await nodes.count(), 2);
    for (const [dx,dy] of [[70,-50],[10,10],[45,65],[-75,55]]) await page.mouse.click(x + dx, y + dy);
    assert.equal(await nodes.count(), 6);
    assert.match(await outline.getAttribute('d'), /C/);
    assert.doesNotMatch(await outline.getAttribute('d'), /Z$/);
    assert.ok(await apply.isDisabled());
    const placed = await outline.getAttribute('d');
    await page.mouse.move(rect.x + rect.width + 5, y);
    assert.equal(await outline.getAttribute('d'), placed);
    await page.mouse.click(rect.x + 10, y + 1);
    await page.waitForFunction(() => !document.querySelector('#apply-lasso').disabled);
    assert.match(await outline.getAttribute('d'), /C.*Z$/);
    await page.keyboard.press('Home');
    assert.ok(await page.locator('#fit').isDisabled());
  }
  await page.mouse.click(cx, cy);
  await page.keyboard.press('Escape');
  assert.equal(await nodes.count(), 0);
  assert.ok(await page.locator('#fit').isEnabled());
  await draw();
  const locked = await camera();
  await navigate('right');
  await navigate('middle');
  await page.mouse.wheel(0, -140);
  assert.deepEqual(await camera(), locked);
  await page.keyboard.press('Escape');
  assert.ok(await apply.isDisabled());
  assert.equal(await outline.getAttribute('d'), null);
  assert.ok(await page.locator('#fit').isEnabled());
  for (const refine of [false, true]) {
    await page.locator('#refine-edges').setChecked(refine);
    await draw();
    await click('save');
    assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
    await page.locator('#viewport > canvas').press(refine ? 'Enter' : 'NumpadEnter');
    assert.ok(await page.locator('#fit').isEnabled());
    await click('save');
    const painted = readProject(await fs.readFile(projectFile)), surface = makeSurface(painted);
    assert.ok(painted.paint.includes(4));
    assert.equal(painted.paint.length > project.paint.length, refine);
    assert.equal(await page.locator('#paint-triangles').innerText(), painted.paint.length.toLocaleString() + ' / 2,000,000 paint triangles');
    for (let i = 0; i < painted.paint.length; i++) {
      if (surface.owners[i] >= topFaces) assert.equal(painted.paint[i], 0);
      if (surface.owners[i] === 42) assert.equal(painted.paint[i], 2);
    }
    await click('undo');
    await click('save');
    assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
    assert.ok(await page.locator('#undo').isDisabled());
  }
});

test('Fill Lasso previews and paints the curved span outside its clicked node bounds', async t => {
  const { page, click, projectFile } = await desktop(t);
  await fs.writeFile(projectFile, writeProject(gapGrid(2, 2, 10)));
  await click('open');
  await page.locator('#view').selectOption('Top');
  await page.locator('[data-tool="Fill Lasso"]').click();
  const rect = await page.locator('#viewport > canvas').boundingBox();
  const x = Math.floor(rect.x + rect.width / 2), y = Math.floor(rect.y + rect.height / 2);
  const sample = () => page.screenshot({clip: {x, y: y - 80, width: 2, height: 2},
    style: '#lasso-outline { visibility: hidden; }'});
  const before = await sample();
  const nodes = page.locator('#lasso-outline circle');
  await page.mouse.click(x, y);
  await page.mouse.click(x + 20, y);
  await page.keyboard.press('Backspace');
  assert.equal(await nodes.count(), 1);
  assert.ok(await page.locator('#fit').isDisabled());
  await page.keyboard.press('Backspace');
  assert.equal(await nodes.count(), 0);
  assert.ok(await page.locator('#fit').isEnabled());
  for (const [dx, dy] of [[-72,-72], [72,-72], [72,72], [-72,72]]) await page.mouse.click(x + dx, y + dy);
  const outline = page.locator('#lasso-curve'), guide = page.locator('#lasso-guide');
  await page.mouse.move(x - 72, y - 72);
  const arc = await guide.getAttribute('d');
  assert.match(arc, /C/);
  const previewedLoop = await outline.getAttribute('d') + ' ' + arc.slice(arc.indexOf('C')) + ' Z';
  await page.mouse.click(x - 72, y - 72);
  assert.equal(await outline.getAttribute('d'), previewedLoop);
  await page.waitForFunction(() => !document.getElementById('apply-lasso').disabled);
  const preview = await sample();
  assert.ok(!before.equals(preview), 'the fill reaches past the straight line between the top nodes');
  await page.keyboard.press('Backspace');
  assert.equal(await nodes.count(), 3);
  assert.doesNotMatch(await outline.getAttribute('d'), /Z$/);
  assert.ok(await page.locator('#apply-lasso').isDisabled());
  assert.ok(await page.locator('#fit').isDisabled());
  await page.keyboard.press('Enter');
  assert.ok(await page.locator('#undo').isDisabled());
  assert.deepEqual(await sample(), before);
  await page.mouse.click(x - 72, y + 72);
  await page.mouse.click(x - 72, y - 72);
  assert.deepEqual(await sample(), preview);
  await click('apply-lasso');
  assert.deepEqual(await sample(), preview);
  await click('undo');
  assert.deepEqual(await sample(), before);
});

test('Fill Gaps previews the entire model and commits precisely the displayed result in one undo step', async t => {
  const { page, click, projectFile } = await desktop(t);
  const project = gapGrid();
  project.mixes = { 4: [{ slot: 1, percent: 50 }, { slot: 2, percent: 50 }] };
  project.palette.push(mixHex(project.palette, project.mixes[4]));
  project.paint.fill(4);
  project.paint[54] = 0;
  project.paint[66] = 2;
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.locator('#view').selectOption('Top');
  const label = page.locator('#gap-count'), size = page.locator('#gap-width');
  const expectCount = text => label.filter({ hasText: text }).waitFor();
  await page.getByRole('button', { name: 'Fill Gaps', exact: true }).click();
  await expectCount('2 gaps to fill');
  const layer = page.locator('#fill-highlight canvas');
  await layer.waitFor({ state: 'visible' });
  const ink = () => layer.evaluate(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v,i) => i % 4 === 3 && v > 0));
  assert.ok(await ink());
  await page.locator('#view').selectOption('Studio');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.ok(await ink());
  await page.locator('#viewport > canvas').click();
  assert.ok(await page.locator('#undo').isDisabled());
  await page.keyboard.press('NumpadEnter');
  await click('save');
  assert.ok(readProject(await fs.readFile(projectFile)).paint.every(slot => slot === 4));
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  assert.ok(await page.locator('#undo').isDisabled(), 'both gaps are restored by a single undo');
  await page.getByRole('button', { name: 'Fill Gaps', exact: true }).click();
  await size.fill('0.13');
  await expectCount('0 gaps to fill');
  assert.ok(await page.locator('#apply-gaps').isDisabled());
  await size.press('Enter');
  assert.ok(await page.locator('#undo').isDisabled());
  await size.fill('');
  await expectCount('Enter a size');
  await size.fill('0.3');
  await size.press('Escape');
  await page.getByRole('button', { name: 'Fill Gaps', exact: true }).click();
  await expectCount('2 gaps to fill');
  await page.getByRole('switch', {name:'Protect Color 3', exact:true}).click();
  await expectCount('1 gap to fill');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  await click('apply-gaps');
  const expected = project.paint.slice();
  expected[54] = 4;
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, expected);
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  await click('redo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, expected);
});

test('Fill Gaps previews and applies the rendered neighbor color for solids and distinct mixes', async t => {
  const { app, page, click, projectFile } = await desktop(t);
  // Physical mouse motion carries the OS modifier state, independent of Playwright's Alt key.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true));
  const project = gapGrid(96, 54); // More than one render chunk.
  project.mixes = { 4: [{ slot: 0, percent: 50 }, { slot: 1, percent: 50 }],
    5: [{ slot: 2, percent: 50 }, { slot: 3, percent: 50 }] };
  for (const recipe of Object.values(project.mixes)) project.palette.push(mixHex(project.palette, recipe));
  project.editingContext = { color: project.palette[4] };
  const cell = (x, y) => (96 * y + x) * 2;
  for (let y = 0; y < 54; y++) {
    for (const [x, slot] of [[0, 1], [32, 4], [64, 5]]) project.paint.fill(slot, cell(x, y), cell(x + 32, y));
  }
  const split = cell(16, 12);
  const expected = project.paint.slice();
  for (const [x, y] of [[16, 12], [48, 44], [80, 42]]) {
    for (const row of [y, y + 1]) project.paint.fill(0, cell(x, row), cell(x + 2, row));
  }
  Object.assign(project, applyLeafEdits(project, new Map([[split, { side: 1, left: 0, right: 0 }]])));
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.locator('#view').selectOption('Top');
  await page.locator('[data-tool="Fill Gaps"]').click();
  await page.locator('#gap-count').filter({ hasText: '3 gaps to fill' }).waitFor();
  const layer = page.locator('#fill-highlight canvas');
  await layer.waitFor({ state: 'visible' });
  // The three square pinholes are horizontally separated. Sample well inside
  // each projected outline to compare the actual lit surface before/after Apply.
  const clips = await layer.evaluate(c => {
    const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const rect = c.getBoundingClientRect(), clips = [];
    let left = -1, top = c.height, bottom = 0;
    for (let x = 0; x < c.width; x++) {
      let hit = false;
      for (let y = 0; y < c.height; y++) {
        if (!pixels[4 * (y * c.width + x) + 3]) continue;
        hit = true; top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      if (hit && left < 0) left = x;
      if (!hit && left >= 0) {
        clips.push({ x: Math.floor(rect.x + (left + x) / 2), y: Math.floor(rect.y + (top + bottom) / 2),
          width: 2, height: 2 });
        left = -1; top = c.height; bottom = 0;
      }
    }
    return clips;
  });
  assert.equal(clips.length, 3);
  const samples = async () => {
    const images = [];
    for (const clip of clips) images.push(await page.screenshot({ clip }));
    return images;
  };
  const preview = await samples();
  await page.keyboard.down('Alt');
  await layer.waitFor({ state: 'hidden' });
  const original = await samples();
  assert.ok(original.every((image, i) => !image.equals(preview[i])), 'every outlined polygon changes visibly');
  await page.keyboard.up('Alt');
  await layer.waitFor({ state: 'visible' });
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  await click('apply-gaps');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, expected);
  const applied = await samples();
  assert.equal(new Set(applied.map(b => b.toString('base64'))).size, 3, 'three different rendered swatches');
  assert.ok(applied.every((image, i) => image.equals(preview[i])), 'each preview interior matches its applied color');
  await click('undo');
  const undone = await samples();
  assert.ok(undone.every((image, i) => image.equals(original[i])));
});

test('Fill Gaps previews an 11.5 mm wedge, applies every gray face and undoes it in one step', async t => {
  const { app, page, click, projectFile } = await desktop(t);
  const p = gapWedge();
  await fs.writeFile(projectFile, writeProject(p));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true));
  await click('open');
  await page.locator('#faces').filter({hasText: '288 source triangles'}).waitFor();
  await page.locator('[data-tool="Fill Gaps"]').click();
  const status = page.locator('#gap-count');
  await page.locator('#gap-width').fill('11.49');
  await status.filter({hasText: '0 gaps to fill'}).waitFor();
  await page.locator('#gap-width').fill('11.5');
  await status.filter({hasText: '1 gap to fill'}).waitFor();
  await page.locator('#gap-seams').check();
  await status.filter({hasText: '1 gap to fill'}).waitFor();
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, p.paint);
  assert.ok(await page.locator('#undo').isDisabled());
  await click('apply-gaps');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, new Uint8Array(p.paint.length));
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, p.paint);
  assert.ok(await page.locator('#undo').isDisabled());
});

test('Fill Gaps skips geometry preparation on a single-swatch model', async t => {
  const { page, click, projectFile } = await desktop(t);
  const project = gapGrid();
  project.paint.fill(2);
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.evaluate(() => {
    window.fillRequests = 0;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.ranges || message.gapPaint) window.fillRequests++;
      return send.call(this, message, ...args);
    };
  });
  await page.getByRole('button', { name: 'Fill Gaps', exact: true }).click();
  await page.locator('#gap-count').filter({ hasText: '0 gaps to fill' }).waitFor();
  await page.locator('#gap-seams').check();
  await page.locator('#gap-count').filter({ hasText: '0 gaps to fill' }).waitFor();
  assert.equal(await page.evaluate(() => window.fillRequests), 0);
  assert.ok(await page.locator('#apply-gaps').isDisabled());
});

test('Fill Gaps Apply preserves a jagged paint edge while fixing a pinhole and a thin seam', async t => {
  const { page, click, projectFile } = await desktop(t);
  const p = gapGrid(24, 14, 0.2), cell = (x, y) => 2 * (24 * y + x);
  p.paint.fill(2, 0, cell(0, 4));
  p.paint.fill(1, cell(0, 4), cell(0, 6));
  p.paint[cell(8, 5) + 1] = 0; // A triangular notch connected to the broad surrounding paint.
  const expected = p.paint.slice();
  p.paint[cell(4, 10)] = 1;
  p.paint.fill(1, cell(10, 10), cell(19, 10));
  await fs.writeFile(projectFile, writeProject(p));
  await click('open');
  await page.locator('[data-tool="Fill Gaps"]').click();
  await page.locator('#gap-seams').check();
  await page.locator('#gap-count').filter({ hasText: '2 gaps to fill' }).waitFor();
  await click('apply-gaps');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, expected);
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, p.paint);
});

test('5 mm seam scan and Apply preserve the uniform surface between two flecks', async t => {
  const { page, click, projectFile } = await desktop(t);
  const project = gapGrid(14, 9, 0.2);
  project.paint[90] = project.paint[125] = 1;
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.locator('[data-tool="Fill Gaps"]').click();
  await page.locator('#gap-width').fill('5');
  await page.locator('#gap-seams').check();
  await page.locator('#gap-count').filter({ hasText: '2 gaps to fill' }).waitFor();
  await click('apply-gaps');
  await click('save');
  assert.ok(readProject(await fs.readFile(projectFile)).paint.every(slot => slot === 0));
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
});

test('changing seam settings can finish a new preview while the previous scan is still running', async t => {
  const { page, click, projectFile } = await desktop(t);
  const project = gapGrid();
  project.paint[54] = 1;
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  // Hold the first seam request in flight, independent of machine speed.
  await page.evaluate(() => {
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.gapPaint && message.includeSeams) {
        window.heldScan = true;
        return;
      }
      return send.call(this, message, ...args);
    };
  });
  await page.getByRole('button', { name: 'Fill Gaps', exact: true }).click();
  await page.locator('#gap-width').fill('5');
  await page.locator('#gap-seams').check();
  await page.waitForFunction(() => window.heldScan);
  const spinner = page.locator('#gap-spinner');
  assert.ok(await spinner.isVisible());
  await page.waitForFunction(() => document.getElementById('gap-spinner').getAnimations()
    .some(animation => animation.playState === 'running' && animation.currentTime > 0));
  await page.locator('#gap-seams').uncheck();
  await page.locator('#gap-count').filter({ hasText: '1 gap to fill' }).waitFor({ timeout: 3000 });
  assert.ok(await spinner.isHidden());
  assert.ok(await page.locator('#apply-gaps').isEnabled());
  assert.ok(await page.locator('#undo').isDisabled());
  await page.evaluate(() => { window.heldScan = false; });
  await page.locator('#gap-seams').check();
  await page.waitForFunction(() => window.heldScan);
  await page.keyboard.press('Escape');
  assert.ok(await spinner.evaluate(el => el.hidden), 'cancel stops the indicator');
});

test('Include thin seams previews two bank colors and applies them together in one Undo', async t => {
  const { app, page, click, projectFile } = await desktop(t);
  const p = gapGrid(24, 14, 0.2);
  for (let i = 0; i < p.vertices.length; i += 3) p.vertices[i] *= 8;
  p.mixes = {4:[{slot:0, percent:50}, {slot:1, percent:50}]};
  p.palette.push(mixHex(p.palette, p.mixes[4]));
  const start = 2*(6*24+4), end = 2*(6*24+20);
  p.paint.fill(4, 2*24*7);
  const fleck = 2*(6*24+1)+1;
  p.paint[fleck] = 2;
  p.paint.fill(2, start, end+1);
  const expected = p.paint.slice();
  expected[fleck] = expected[end] = 0;
  for (let id = start; id < end; id++) expected[id] = id % 2 ? 4 : 0;
  await fs.writeFile(projectFile, writeProject(p));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true));
  await page.locator('#open').evaluate(el => el.click());
  await page.locator('#faces').filter({hasText:'672 source triangles'}).waitFor();
  await page.locator('#busy').waitFor({state:'hidden'});
  await page.locator('[data-tool="Fill Gaps"]').click();
  const status = page.locator('#gap-count');
  await status.filter({hasText:'0 gaps to fill'}).waitFor();
  await page.evaluate(() => {
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.includeSeams) this.addEventListener('message', ({data}) => {
        if (data.id === message.id && data.value?.targets) window.seamPreview = Array.from(data.value.targets);
      });
      return send.call(this, message, ...args);
    };
  });
  await page.getByLabel('Include thin seams').check();
  await status.filter({hasText:'2 gaps to fill'}).waitFor();
  const preview = await page.evaluate(() => window.seamPreview);
  assert.deepEqual(preview, Array.from(expected, (slot, i) => slot === p.paint[i] ? 255 : slot));
  assert.ok(await page.locator('#undo').isDisabled());
  await click('apply-gaps');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, expected);
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, p.paint);
  assert.ok(await page.locator('#undo').isDisabled());
});

test('Include thin seams is opt-in, recomputes the preview and applies in one undoable edit', async t => {
  const { page, click, projectFile } = await desktop(t);
  const project = gapGrid(16, 8, 0.2);
  project.paint.fill(2, 2 * (16 * 4 + 2), 2 * (16 * 4 + 14));
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.getByRole('button', { name: 'Fill Gaps', exact: true }).click();
  const seams = page.getByRole('checkbox', { name: 'Include thin seams' });
  const count = n => page.locator('#gap-count').filter({ hasText: n === 1 ? '1 gap to fill' : '0 gaps to fill' }).waitFor();
  assert.equal(await seams.isChecked(), false);
  await count(0);
  await seams.check();
  await count(1);
  await page.locator('#gap-width').fill('0.15');
  await count(0);
  await page.locator('#gap-width').fill('0.25');
  await count(1);
  await seams.uncheck();
  await count(0);
  assert.ok(await page.locator('#apply-gaps').isDisabled());
  await seams.check();
  await count(1);
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  await click('apply-gaps');
  await click('save');
  assert.ok(readProject(await fs.readFile(projectFile)).paint.every(slot => slot === 0));
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  await click('redo');
  await click('save');
  assert.ok(readProject(await fs.readFile(projectFile)).paint.every(slot => slot === 0));
});

test('Band previews, cancels and paints around the model; Alt-click samples committed slots', async t => {
  const { app, page, click, dir, projectFile } = await desktop(t);
  const project = readSTL(fixture(), 'Bands.stl');
  project.mixes = { 4: [{ slot: 1, percent: 50 }, { slot: 2, percent: 50 }] };
  project.palette.push(mixHex(project.palette, project.mixes[4]));
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.locator('#view').selectOption('Front');
  await click('projection');
  await page.keyboard.press('h');
  const canvas = page.locator('#viewport > canvas'), box = await canvas.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const clip = { x: x - 18, y: y - 9, width: 36, height: 8 };
  const mix = page.getByRole('button', { name: 'Mix 1', exact: true });
  await mix.click();
  const before = await page.screenshot({ clip });
  await page.mouse.click(x, y);
  await page.mouse.move(x, y - 10);
  assert.ok(await page.locator('#apply-band').isDisabled());
  assert.ok(!(await page.screenshot({ clip })).equals(before), 'moving the pointer previews the band');
  await page.keyboard.down('Alt');
  assert.ok((await page.screenshot({ clip })).equals(before), 'sampling reveals the underlying paint');
  await page.keyboard.up('Alt');
  assert.ok(!(await page.screenshot({ clip })).equals(before), 'releasing Alt restores the placement');
  await page.keyboard.press('Escape');
  assert.ok((await page.screenshot({ clip })).equals(before));
  assert.ok(await page.locator('#undo').isDisabled());
  await page.mouse.click(x, y);
  await page.mouse.click(x, y - 10);
  assert.ok(await page.locator('#undo').isDisabled(), 'second click only sets the bounds');
  await click('apply-band');
  await page.waitForFunction(() => !document.getElementById('undo').disabled);
  await click('undo');
  assert.ok((await page.screenshot({ clip })).equals(before));

  await page.mouse.click(x, y);
  const lower = page.locator('#band-lower'), upper = page.locator('#band-upper');
  const picked = Number(await lower.inputValue());
  await upper.fill(String(picked + 2));
  assert.ok(await page.locator('#undo').isDisabled(), 'editing a bound cannot commit paint');
  await upper.press('NumpadEnter');
  await page.waitForFunction(() => !document.getElementById('undo').disabled);
  await click('save');
  const painted = readProject(await fs.readFile(projectFile));
  const { positions } = makeSurface(painted);
  let low = Infinity, high = -Infinity, near = false, far = false;
  painted.paint.forEach((slot, id) => {
    if (slot !== 4) return;
    for (let k = id * 9; k < id * 9 + 9; k += 3) {
      low = Math.min(low, positions[k + 2]);
      high = Math.max(high, positions[k + 2]);
      near ||= positions[k + 1] === -26;
      far ||= positions[k + 1] === 26;
    }
  });
  assert.ok(near && far, 'paint reaches the front and back of the slab');
  assert.ok(Math.abs(high - low - 2) < 0.08, 'saved band measures ' + (high - low) + ' mm');
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  await click('redo');
  await click('save');
  const redone = readProject(await fs.readFile(projectFile));
  assert.deepEqual(redone.paint, painted.paint);
  assert.deepEqual(redone.splits, painted.splits);
  const output = path.join(dir, 'Band.3mf');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, output);
  await click('export');
  const { unzipSync, strFromU8 } = await import('fflate');
  const archive = unzipSync(await fs.readFile(output));
  assert.match(strFromU8(archive['3D/3dmodel.model']), /paint_color="[^"]*2C/);
  assert.ok(JSON.parse(strFromU8(archive['Metadata/project_settings.config'])).mixed_filament_definitions);
  await click('open');
  assert.equal(Number(await lower.inputValue()), picked);
  assert.equal(Number(await upper.inputValue()), picked + 2);
  assert.equal(await page.locator('#tool-title').innerText(), 'Fill Band');
  await page.locator('#view').selectOption('Back');
  await page.locator('[data-tool="Eraser"]').click();
  const base = page.getByRole('button', {name: 'Color 1 (base)', exact: true});
  await base.click();
  await page.getByRole('button', {name: 'Mixed colors', exact: true}).click();
  await page.keyboard.down('Alt');
  await page.mouse.click(x, y - 3);
  assert.equal(await mix.getAttribute('aria-pressed'), 'true');
  await page.mouse.click(x, y + 5);
  await page.keyboard.up('Alt');
  assert.equal(await base.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#tool-title').innerText(), 'Eraser');
  assert.ok(await page.locator('#dirty').isHidden());
  assert.ok(await page.locator('#undo').isDisabled());
});

test('Band accepts off-model bounds in either order and includes the entire underside on Apply', async t => {
  const { page, click, projectFile } = await desktop(t);
  const project = readSTL(fixture(), 'Raised slab.stl'), baseZ = 31.25;
  for (let k = 2; k < project.vertices.length; k += 3) project.vertices[k] += baseZ;
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.locator('[data-swatch="2"]').click();
  await page.locator('#view').selectOption('Front');
  await page.getByRole('button', { name: 'Fill Band', exact: true }).click();
  const box = await page.locator('#viewport > canvas').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const above = box.y + box.height * 0.2, below = box.y + box.height * 0.8;
  const lower = page.locator('#band-lower'), upper = page.locator('#band-upper');
  const apply = page.locator('#apply-band');
  // Perspective and orthographic views both accept empty-space picks.
  await page.mouse.click(x, above);
  await page.mouse.click(x, below);
  assert.deepEqual([await lower.inputValue(), await upper.inputValue()], ['0','12']);
  await page.keyboard.press('Escape');
  await click('projection');
  await page.mouse.click(x, below);
  await page.mouse.click(x, above);
  assert.deepEqual([await lower.inputValue(), await upper.inputValue()], ['0','12']);
  await page.keyboard.press('Escape');
  // Pick an interior height first, then click below the model for the base.
  await page.mouse.click(x, y);
  await page.mouse.click(x, below);
  assert.equal(await lower.inputValue(), '0');
  assert.ok(Number(await upper.inputValue()) > 0 && Number(await upper.inputValue()) < 12);
  await page.mouse.move(x, above);
  assert.ok(Number(await upper.inputValue()) < 12, 'hover after second click keeps the selection fixed');
  await lower.fill('7');
  await upper.fill('6');
  assert.ok(await apply.isDisabled());
  await lower.fill('0');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  await click('open');
  assert.deepEqual([await lower.inputValue(), await upper.inputValue()], ['0','6']);
  assert.ok(await apply.isEnabled());
  await apply.press('Enter'); // Explicit activation of the Apply button.
  await page.waitForFunction(() => !document.getElementById('undo').disabled);
  await click('save');
  const painted = readProject(await fs.readFile(projectFile)), { positions } = makeSurface(painted);
  let underside = 0, aboveBand = 0;
  painted.paint.forEach((slot, i) => {
    const z = [2,5,8].map(k => positions[9*i+k] - baseZ);
    if (Math.max(...z) === 0) underside++;
    if (Math.max(...z) < 6 - 0.04) assert.equal(slot, 2);
    if (Math.min(...z) > 6 + 0.04) { assert.equal(slot, 0); aboveBand++; }
  });
  assert.ok(underside > 0 && aboveBand > 0);
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
});

test('Band restores legacy Z projects and picks, previews, saves and applies model-space X and Y bands', async t => {
  const { page, click, projectFile } = await desktop(t);
  const project = readSTL(fixture(), 'Axis bands.stl');
  project.editingContext = { tool: 'Height Band', bandBounds: { lower: 1, upper: 3, pending: true } };
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  const direction = page.getByRole('combobox', { name: 'Direction' });
  const from = page.getByRole('spinbutton', { name: 'From (mm)' }), to = page.getByRole('spinbutton', { name: 'To (mm)' });
  assert.equal(await page.locator('#tool-title').innerText(), 'Fill Band');
  assert.equal(await page.locator('#tool-key').innerText(), 'H');
  assert.equal(await direction.inputValue(), '2');
  assert.deepEqual([await from.inputValue(), await to.inputValue()], ['1','3']);
  await page.keyboard.press('Escape');
  await page.locator('[data-swatch="2"]').click();
  await click('projection');
  const box = await page.locator('#viewport > canvas').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const clip = { x: Math.round(x) - 3, y: Math.round(y) - 3, width: 6, height: 6 };
  for (const [axis, view, span, base] of [[0,'Back',95,-40], [1,'Left',52,-26]]) {
    await direction.selectOption(String(axis));
    await page.locator('#view').selectOption(view);
    await page.keyboard.press('Escape');
    const before = await page.screenshot({ clip });
    // Both views reverse the selected axis on screen.
    await page.mouse.click(box.x + 4, y);
    assert.equal(Number(await from.inputValue()), span);
    await page.mouse.click(box.x + box.width - 16, y);
    assert.deepEqual([await from.inputValue(), await to.inputValue()], ['0',String(span)]);
    await page.mouse.click(x, y);
    const mid = Number(await from.inputValue());
    assert.ok(Math.abs(mid - span / 2) < 1);
    await page.mouse.click(box.x + box.width - 16, y);
    await to.fill(String(mid + 2));
    assert.ok(!(await page.screenshot({ clip })).equals(before), 'preview covers the center');
    await direction.selectOption('2'); // same distances now preview along Z
    await from.fill('20');
    assert.ok((await page.screenshot({ clip })).equals(before), 'Z preview beyond the slab is empty');
    await direction.selectOption(String(axis));
    await from.fill('0');
    await page.locator('#view').selectOption('Studio');
    await click('save');
    await click('open');
    assert.equal(await direction.inputValue(), String(axis));
    assert.equal(await to.inputValue(), String(mid + 2));
    assert.ok(await page.locator('#undo').isDisabled());
    await click('apply-band');
    await click('save');
    const painted = readProject(await fs.readFile(projectFile)), { positions } = makeSurface(painted);
    let inside = 0, outside = 0;
    painted.paint.forEach((slot, i) => {
      const coordinates = [0,3,6].map(k => positions[9*i+k+axis] - base);
      if (Math.max(...coordinates) < mid + 1.95) { assert.equal(slot, 2); inside++; }
      if (Math.min(...coordinates) > mid + 2.05) { assert.equal(slot, 0); outside++; }
    });
    assert.ok(inside && outside);
    await click('undo');
    await click('save');
    assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  }
});

test('swatch locks protect solid and mixed paint through previews, editing, clearing and reopening', async t => {
  const { page, click, projectFile } = await desktop(t);
  const project = readSTL(fixture(), 'Locked trim.stl');
  project.mixes = { 4: [{ slot: 1, percent: 50 }, { slot: 2, percent: 50 }] };
  project.palette.push(mixHex(project.palette, project.mixes[4]));
  project.paint.fill(4);
  project.paint[0] = 2;
  project.stamps = [{ name: 'Dot', width: 1, height: 1, pixels: Uint8Array.of(1),
    source: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64') }];
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  const lock = name => page.getByRole('switch', { name: 'Protect ' + name, exact: true });
  const mix = lock('Mix 1'), solid = lock('Color 3');
  await solid.click();
  await mix.press('Space');
  await click('undo');
  assert.equal(await mix.isChecked(), false);
  await click('redo');
  await click('save');
  await click('open');
  assert.ok(await mix.isChecked() && await solid.isChecked());
  assert.equal(await page.locator('[data-swatch="1"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#view').selectOption('Front');
  await click('projection');
  const box = await page.locator('#viewport > canvas').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  for (const tool of ['Brush', 'Eraser']) {
    await page.locator(`[data-tool="${tool}"]`).click();
    for (const refine of [false, true]) {
      await page.locator('#refine-edges').setChecked(refine);
      await page.mouse.click(x, y);
    }
  }
  await page.locator('[data-tool="Fill"]').click();
  await page.locator('#protect').uncheck();
  await page.mouse.click(x, y);
  assert.ok(await page.locator('#fill-highlight').isHidden());
  for (const tool of ['Text', 'Stamps']) {
    await page.locator(`[data-tool="${tool}"]`).click();
    if (tool === 'Text') await page.locator('#text-content').fill('Trim');
    else await page.locator('.stamp-choice').click();
    for (const refine of [false, true]) {
      await page.locator('#refine-stamp').setChecked(refine);
      await page.mouse.click(x, y);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await page.locator('#apply').isDisabled(), tool + ' skips locked paint');
    }
  }
  await page.getByRole('button', { name: 'Fill Band', exact: true }).click();
  const clip = { x: x - 18, y: y - 9, width: 36, height: 8 };
  const before = await page.screenshot({ clip });
  await page.mouse.click(x, y);
  await page.mouse.move(x, y - 10);
  await page.mouse.click(x, y - 10);
  assert.ok(await page.locator('#apply-band').isEnabled());
  assert.ok((await page.screenshot({ clip })).equals(before), 'locked area retains its color during band preview');
  await click('apply-band');
  await click('project-actions');
  await click('clear-paint');
  assert.ok(await page.locator('#undo').isDisabled(), 'fully locked tools leave no edit history');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  await solid.click();
  await click('project-actions');
  await click('clear-paint');
  await click('save');
  const cleared = readProject(await fs.readFile(projectFile));
  assert.deepEqual(cleared.paint, project.paint.map(i => i === 4 ? 4 : 0));
  await click('undo');
  await mix.click();
  await page.locator('[data-tool="Brush"]').click();
  await page.mouse.click(x, y);
  await click('save');
  assert.ok(readProject(await fs.readFile(projectFile)).paint.includes(1), 'unlocking allows painting again');

  // A single wide stroke straddles detailed trim and editable material.
  const positions = makeSurface(project).positions;
  project.paint = project.paint.map((_, id) => {
    const k = id * 9;
    return (positions[k] + positions[k + 3] + positions[k + 6]) / 3 < 7.5 ? 4 : 0;
  });
  project.editingContext = { lockedSlots: [4] };
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.locator('#view').selectOption('Top');
  await page.locator('#brush-size').press('End');
  await page.mouse.move(x - 45, y);
  await page.mouse.down();
  await page.mouse.move(x + 45, y, { steps: 4 });
  await page.mouse.up();
  await click('save');
  const brushed = readProject(await fs.readFile(projectFile));
  assert.ok(brushed.paint.includes(1), 'wide brush reaches unlocked paint');
  const lockedVertices = (vertices, paint) => vertices.filter((_, k) => paint[Math.floor(k / 9)] === 4);
  assert.deepEqual(lockedVertices(makeSurface(brushed).positions, brushed.paint),
    lockedVertices(positions, project.paint), 'every locked trim triangle survives the crossing stroke');
});

test('Clear all paint resets every leaf to the custom base and supports one-step undo and redo', async (t) => {
  const { page, click, projectFile } = await desktop(t);
  const project = readSTL(fixture(), 'Mixed slab.stl');
  project.palette[0] = '#553322';
  const mix = [{slot:1,percent:50},{slot:2,percent:50}];
  project.mixes = {4:mix};
  project.palette.push(mixHex(project.palette, mix));
  project.paint.fill(2);
  Object.assign(project, applyLeafEdits(project, new Map([[0, {side:1,left:0,right:4}]])));
  project.stamps = [{name:'Logo',width:2,height:1,pixels:Uint8Array.of(4,255),
    source:Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64'))}];
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.getByRole('button', {name:'Mix 1', exact:true}).click();
  await page.locator('[data-tool="Text"]').click();
  await page.locator('#text-content').fill('Test');
  await page.waitForFunction(() => !document.getElementById('apply').disabled);
  const clear = page.locator('header #clear-paint');
  assert.ok(await clear.isHidden());
  assert.equal(await page.locator('#painting-sidebar #clear-paint').count(), 0);
  await page.getByRole('button', { name: 'Project', exact: true }).press('Enter');
  assert.ok(await clear.isVisible());
  await page.keyboard.press('Escape');
  assert.ok(await clear.isHidden());
  assert.ok(await page.locator('#apply').isEnabled(), 'closing Project keeps the text preview');
  await click('project-actions');
  await click('clear-paint');
  assert.ok(await page.locator('#apply').isDisabled());
  assert.ok(await page.locator('#dirty').isVisible());
  await click('save');
  const cleared = readProject(await fs.readFile(projectFile));
  assert.ok(cleared.paint.every(slot => slot === 0));
  assert.deepEqual(cleared.splits, project.splits);
  assert.deepEqual(cleared.palette, project.palette);
  assert.deepEqual(cleared.mixes, project.mixes);
  assert.deepEqual(cleared.stamps, project.stamps);
  await click('project-actions');
  await click('clear-paint');
  assert.ok(await page.locator('#dirty').isHidden(), 'clearing an already blank model preserves the save point');
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, project.paint);
  await click('redo');
  await click('save');
  await click('open');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, cleared.paint);
});

test('new STLs inherit the active palette and selection, while saved projects restore their own', async t => {
  const { app, page, click, dir, projectFile } = await desktop(t);
  const donor = readSTL(fixture(), 'Donor.stl');
  donor.palette[0] = '#223344';
  donor.mixes = {4: [{slot:0, percent:33}, {slot:2, percent:67}]};
  donor.palette.push(mixHex(donor.palette, donor.mixes[4]));
  donor.paint.fill(4);
  const donorPath = path.join(dir, 'Donor.stlp');
  await fs.writeFile(donorPath, writeProject(donor));
  const openFile = async file => {
    await app.evaluate((_, file) => { global.openFixture = file; }, file);
    await click('open');
  };
  await openFile(donorPath);
  await click('add-color');
  const activeColors = await page.locator('#palette .palette-hex').allTextContents();
  const expectedPalette = [...donor.palette, activeColors.at(-1)];
  await page.getByRole('button', {name:'Mix 1', exact:true}).click();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response:1 }); });
  for (const name of ['First.stl', 'Second.STL']) {
    const meshPath = path.join(dir, name);
    await fs.writeFile(meshPath, fixture());
    await openFile(meshPath);
    assert.equal(await page.getByRole('button', {name:'Mix 1', exact:true}).getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('#dirty').isHidden());
    await click('save');
    const imported = readProject(await fs.readFile(projectFile));
    assert.deepEqual(imported.palette, expectedPalette);
    assert.deepEqual(imported.mixes, donor.mixes);
    assert.equal(imported.editingContext.color, donor.palette[4]);
    assert.ok(imported.paint.every(slot => slot === 0));
  }
  await openFile(donorPath);
  assert.equal(await page.locator('#palette .palette-hex').count(), donor.palette.length - 1);
  assert.equal(await page.getByRole('button', {name:'Color 2', exact:true}).getAttribute('aria-pressed'), 'true');
});

test('a saved palette can be loaded into a painted project and undone in one step', async t => {
  const { app, page, click, dir, projectFile } = await desktop(t);
  const palettePath = path.join(dir, 'Workshop.stlpalette');
  const donor = readSTL(fixture(), 'Donor.stl');
  donor.palette = ['#EEEEEE', '#FF0000', '#0000FF'];
  donor.mixes = { 3: [{ slot: 1, percent: 33 }, { slot: 2, percent: 67 }] };
  donor.palette.push(mixHex(donor.palette, donor.mixes[3]));
  await fs.writeFile(projectFile, writeProject(donor));
  await click('open');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async (_, options) => {
      if (options.filters[0].extensions[0] !== 'stlpalette') throw Error('Unexpected destination');
      return { canceled: false, filePath: file };
    };
  }, palettePath);
  await click('save-palette');
  const savedPalette = await fs.readFile(palettePath, 'utf8');
  assert.deepEqual(JSON.parse(savedPalette).mixes, donor.mixes);
  assert.ok(await page.locator('#dirty').isHidden());

  const receiverPath = path.join(dir, 'Receiver.stlp');
  const receiver = readSTL(fixture(), 'Slab.stl');
  receiver.palette = ['#111111', '#0000FE', donor.palette[3], '#FF0000'];
  receiver.paint.set([0, 1, 2, 3]);
  receiver.stamps = [{ name: 'Logo', width: 4, height: 1, pixels: Uint8Array.of(255, 1, 2, 3),
    source: Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64')) }];
  await fs.writeFile(receiverPath, writeProject(receiver));
  await app.evaluate((_, file) => { global.openFixture = file; }, receiverPath);
  await click('open');
  await app.evaluate((_, file) => { global.openFixture = file; }, palettePath);
  await click('load-palette');
  assert.equal(await page.locator('#docname').textContent(), 'Receiver.stlp');
  assert.ok(await page.locator('#dirty').isVisible());
  await click('save-palette');
  assert.ok(await page.locator('#dirty').isVisible());
  await click('save');
  const result = readProject(await fs.readFile(receiverPath));
  assert.deepEqual(result.palette, donor.palette);
  assert.deepEqual(result.mixes, donor.mixes);
  assert.deepEqual(result.paint, receiver.paint.map(slot => [0, 2, 3, 1][slot]));
  assert.deepEqual(result.stamps[0].pixels, Uint8Array.of(255, 2, 3, 1));
  assert.equal(await fs.readFile(palettePath, 'utf8'), savedPalette);

  await click('load-palette');
  assert.ok(await page.locator('#dirty').isHidden());
  await click('undo');
  await click('save');
  const undone = readProject(await fs.readFile(receiverPath));
  assert.deepEqual(undone.paint, receiver.paint);
  assert.deepEqual(undone.palette, receiver.palette);
  assert.deepEqual(undone.stamps, receiver.stamps);
  await click('redo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(receiverPath)), result);

  await fs.writeFile(palettePath, '{}');
  await click('load-palette');
  await page.locator('#notice[open] button').click();
  assert.ok(await page.locator('#dirty').isHidden());
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await click('load-palette');
  await click('save-palette');
  assert.ok(await page.locator('#dirty').isHidden());
  assert.equal(await fs.readFile(palettePath, 'utf8'), '{}');
});

test('Save As updates the viewport heading to the new filename and keeps it on reopen', async t => {
  const { app, page, dir, click } = await desktop(t);
  await click('save');
  const variant = path.join(dir, 'secretaire.v2.STLP');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    global.openFixture = file;
  }, variant);
  await click('save-as');
  async function checkTitle() {
    assert.equal(await page.locator('#docname').innerText(), path.basename(variant));
    assert.equal(await page.locator('#model-name').innerText(), 'secretaire.v2');
  }
  await checkTitle();
  await click('open');
  await checkTitle();
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await click('save-as');
  await checkTitle();
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, path.join(dir, 'missing-folder', 'failed.stlp'));
  await click('save-as');
  await page.locator('#notice[open] button').click();
  await checkTitle();
});

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

test('a failed export removes its temporary file and a retry writes a complete archive', async t => {
  const { app, page, click, dir } = await desktop(t);
  const blocked = path.join(dir, 'Directory.3mf'), output = path.join(dir, 'Retried.3mf');
  await fs.mkdir(blocked);
  await app.evaluate(({ dialog }, paths) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.shift() });
  }, [blocked, output]);
  await click('export');
  await page.locator('#notice[open]').waitFor();
  assert.ok((await fs.stat(blocked)).isDirectory());
  assert.ok(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp')));
  await page.locator('#notice button').click();
  await click('export');
  const archive = await fs.readFile(output);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  assert.equal(await page.locator('#status').innerText(), 'Exported Retried.3mf');
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
  await page.getByRole('button', {name:/^Color 1 · 67% \+ Color 2 · 33% · #/}).click();
  assert.equal(await first.inputValue(), '67');
  await click('confirm-mix');
  assert.match(await rows.first().innerText(), /Color 1 · 67% \+ Color 2 · 33%/);
  await mixedToggle.click();
  assert.ok(await page.locator('#mixed-colors').isHidden());
  assert.ok(await page.locator('#palette').isVisible());
  await mixedToggle.click();
  await click('add-mix');
  await page.locator('#mix-count').selectOption('3');
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

test('number keys select the first ten sidebar swatches and leave text entry alone', async t => {
  const { page, click, projectFile } = await desktop(t);
  const active = page.locator('[data-swatch][aria-pressed=true]');
  const original = await active.getAttribute('data-swatch');
  await page.locator('#viewport > canvas').focus();
  await page.keyboard.press('0');
  assert.equal(await active.getAttribute('data-swatch'), original);
  const project = gapGrid();
  const parts = [{slot: 1, percent: 50}, {slot: 2, percent: 50}];
  project.mixes = {4: parts};
  project.palette.push(mixHex(project.palette, parts), '#121212', '#343434', '#565656', '#787878', '#A0A0A0');
  await fs.writeFile(projectFile, writeProject(project));
  await click('open');
  await page.locator('[data-tool="Fill"]').click();
  await page.locator('[aria-controls="mixed-colors"]').click();
  const expected = [0,1,2,3,5,6,7,8,9,4];
  for (const [i, key] of [...'1234567890'].entries()) {
    await page.keyboard.press(key);
    assert.equal(await active.getAttribute('data-swatch'), String(expected[i]));
    assert.equal(await active.locator('kbd').innerText(), key);
  }
  assert.ok(await page.locator('#mixed-colors').isVisible());
  assert.equal(await page.locator('#tool-title').innerText(), 'Fill');
  await click('add-color');
  await page.keyboard.press('0');
  assert.equal(await active.getAttribute('aria-label'), 'Color 10');
  assert.equal(await page.locator('[data-swatch="4"]').getAttribute('aria-keyshortcuts'), null);
  await page.locator('[data-tool="Text"]').click();
  await page.locator('#text-content').fill('');
  await page.locator('#text-content').pressSequentially('1230');
  assert.equal(await page.locator('#text-content').inputValue(), '1230');
  assert.equal(await active.getAttribute('aria-label'), 'Color 10');
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
  assert.match(await page.locator('#mix-suggestions [aria-pressed=true]').getAttribute('title'), /Color 1 · 34%/);
  assert.equal(await page.locator('#mix-suggestions').getByRole('button', {
    name: /^Color 1 · \d+% \+ Color 2 · \d+% \+ Color 3 · \d+% · #/,
  }).count(), 1);
});

test('mix suggestions cover each physical pair and trio and only save on confirmation', async (t) => {
  const { page, click, projectFile } = await desktop(t);
  await click('add-mix');
  const gallery = page.locator('#mix-suggestions');
  const swatches = gallery.getByRole('button');
  const shares = page.locator('#mix-parts input');
  const buttons = await swatches.evaluateAll(nodes => nodes.map(b => {
    const rect = b.getBoundingClientRect();
    return {
      recipe: b.title.split(' · #')[0],
      color: b.style.getPropertyValue('--swatch'),
      text: b.textContent,
      visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight,
    };
  }));
  const expected = [];
  for (const ids of [[1,2],[1,3],[1,4],[2,3],[2,4],[3,4],[1,2,3],[1,2,4],[1,3,4],[2,3,4]]) {
    const ratios = ids.length === 2 ? [[50,50],[33,67],[67,33]] : [[33,33,34]];
    for (const ratio of ratios) expected.push(ids.map((id,i) => `Color ${id} · ${ratio[i]}%`).join(' + '));
  }
  assert.deepEqual(buttons.map(b => b.recipe).sort(), expected.sort());
  assert.ok(buttons.every(b => b.visible && b.text === '' && /^#[0-9A-F]{6}$/.test(b.color)));
  const pair = gallery.getByRole('button',{name:/^Color 2 · 33% \+ Color 4 · 67% · #/});
  await pair.click();
  assert.equal(await pair.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await shares.evaluateAll(nodes => nodes.map(n => n.valueAsNumber)), [33,67]);
  await shares.first().fill('45');
  assert.equal(await gallery.locator('[aria-pressed=true]').count(), 0);
  const trio = gallery.getByRole('button',{name:/^Color 2 · 33% \+ Color 3 · 33% \+ Color 4 · 34% · #/});
  await trio.focus();
  await trio.press('Enter');
  assert.equal(await page.locator('#mix-count').inputValue(), '3');
  assert.deepEqual(await shares.evaluateAll(nodes => nodes.map(n => n.valueAsNumber)), [33,33,34]);
  await pair.click();
  assert.equal(await page.locator('#mix-count').inputValue(), '2');
  await trio.click();
  const title = await trio.getAttribute('title');
  assert.ok((await page.locator('#mix-preview').innerText()).includes(title.slice(-7)));
  await page.locator('#mix-editor button[value=cancel]').click();
  assert.equal(await page.locator('#mixed-colors .swatch-row').count(), 0);
  await click('add-mix');
  await trio.click();
  await click('confirm-mix');
  await click('save');
  const saved = readProject(await fs.readFile(projectFile));
  assert.deepEqual(saved.mixes[4], [{slot:1,percent:33},{slot:2,percent:33},{slot:3,percent:34}]);
  await click('add-color');
  await click('add-mix');
  assert.equal(await swatches.count(), 40); // Ten pairs with three ratios each, plus ten trios.
  assert.ok(await gallery.getByRole('button', {name:title + ' (already in palette)',exact:true}).isDisabled());
  await page.locator('#mix-editor button[value=cancel]').click();
  await page.getByRole('button',{name:'Edit Mix 1',exact:true}).click();
  const current = gallery.getByRole('button',{name:title,exact:true});
  assert.equal(await current.getAttribute('aria-pressed'), 'true');
  assert.ok(await current.isEnabled());
});

test('large palettes show at most 90 mix suggestions and custom recipes remain editable', async (t) => {
  const { page, click, projectFile } = await desktop(t);
  const swatches = page.locator('#mix-suggestions button');
  const cancel = page.locator('#mix-editor button[value=cancel]');
  for (let count = 4; count <= 16; count++) {
    if (count > 4) await click('add-color');
    if (![4,5,6,7,16].includes(count)) continue;
    await click('add-mix');
    const names = await swatches.evaluateAll(buttons => buttons.map(b => b.title));
    const pairs = count * (count - 1) / 2, trios = pairs * (count - 2) / 3;
    assert.equal(names.length, Math.min(90, 3 * pairs + trios));
    assert.equal(new Set(names).size, names.length);
    if (names.length === 90) {
      assert.equal(names.filter(name => name.split(' + ').length === 3).length, Math.min(45, trios));
      assert.ok(names.some(name => name.includes('Color ' + count + ' ·')));
    }
    if (count < 16) await cancel.click();
  }

  const selects = page.locator('#mix-parts select');
  await selects.first().selectOption('14');
  await selects.last().selectOption('15');
  await page.getByLabel('Filament 1 percentage', {exact:true}).fill('44');
  assert.equal(await page.locator('#mix-suggestions [aria-pressed=true]').count(), 0);
  await click('confirm-mix');
  await click('save');
  const saved = readProject(await fs.readFile(projectFile));
  assert.deepEqual(saved.mixes[16], [{slot:14,percent:44},{slot:15,percent:56}]);
  await page.getByRole('button', {name:'Edit Mix 1',exact:true}).click();
  assert.equal(await swatches.count(), 90);
  assert.match(await page.locator('#mix-suggestions [aria-pressed=true]').getAttribute('title'), /Color 15 · 44%/);
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
  assert.equal(await page.locator('#model-name').innerText(), path.parse(projectFile).name);
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
  assert.equal(await page.locator('#model-name').innerText(), path.parse(other).name);
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
  assert.equal(await page.locator('#model-name').innerText(), path.parse(projectFile).name);
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

test('Fill hover and click agree across a painted bevel as angle and protection change', async t => {
  const { app, page, click, projectFile } = await desktop(t);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true));
  const model = readSTL(fixture(), 'Bevel.stl');
  model.depth.fill(0);
  model.paint = new Uint8Array(model.depth.length);
  model.paint.fill(1, 4, 6);
  await fs.writeFile(projectFile, writeProject(model));
  await click('open');
  await page.locator('#view').selectOption('Top');
  if (await page.locator('#projection').innerText() === 'Perspective') await click('projection');
  await page.locator('[data-tool="Fill"]').click();
  await page.getByRole('button', {name:'Color 3', exact:true}).click();
  const box = await page.locator('#viewport > canvas').boundingBox();
  const scale = box.height / (2 * Math.hypot(95, 52, 12) * 1.75 *
    Math.max(1, box.height / box.width) * Math.tan(35 * Math.PI / 360));
  const bevelX = Math.floor(box.width / 2 + (36 - 7.5) * scale), y = Math.floor(box.height / 2);
  const centerX = Math.floor(box.width / 2);
  await page.mouse.move(box.x + centerX, box.y + y);
  async function checkBevel(included) {
    await page.waitForFunction(({ bevelX, centerX, y, included }) => {
      const layer = document.getElementById('fill-highlight');
      if (layer.hidden) return false;
      const ctx = layer.firstElementChild.getContext('2d');
      return ctx.getImageData(centerX, y, 1, 1).data[3] > 0 &&
        (ctx.getImageData(bevelX, y, 1, 1).data[3] > 0) === included;
    }, { bevelX, centerX, y, included });
  }
  await checkBevel(false);
  await page.locator('#protect').evaluate(el => el.click());
  await checkBevel(true);
  async function angle(value) {
    await page.locator('#angle').evaluate((el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input'));
    }, value);
  }
  const brushSize = await page.locator('#brush-size').inputValue();
  await page.locator('#protect').focus();
  await angle(28);
  await page.keyboard.press('[');
  assert.equal(await page.locator('#angle-value').innerText(), '27°');
  await checkBevel(true);
  await page.keyboard.press('[');
  assert.equal(await page.locator('#angle').inputValue(), '26');
  await checkBevel(false);
  await page.keyboard.press(']');
  assert.equal(await page.locator('#angle-value').innerText(), '27°');
  await checkBevel(true);
  await angle(1);
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  assert.equal(await page.locator('#angle-value').innerText(), '0°');
  await angle(179);
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  assert.equal(await page.locator('#angle-value').innerText(), '180°');
  assert.equal(await page.locator('#brush-size').inputValue(), brushSize);
  assert.ok(await page.locator('#dirty').isHidden());
  await angle(35);
  await checkBevel(true);
  await page.mouse.click(box.x + centerX, box.y + y);
  await click('save');
  const expected = model.paint.slice();
  expected.fill(2, 4, 8);
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, expected);
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, model.paint);
});

test('holding a Fill bracket steps once, pauses, and repeats until release', async t => {
  const { page } = await desktop(t);
  await page.locator('[data-tool="Fill"]').click();
  await page.clock.install({ time: new Date('2030-01-01T12:00:00Z') });
  await page.clock.pauseAt(new Date('2030-01-01T12:00:01Z'));
  const angle = page.locator('#angle');
  await page.keyboard.down(']');
  assert.equal(await angle.inputValue(), '36');
  await page.keyboard.down(']'); // Simulate a native repeated keydown.
  await page.clock.runFor(399);
  assert.equal(await angle.inputValue(), '36');
  await page.clock.runFor(1);
  assert.equal(await angle.inputValue(), '37');
  await page.clock.runFor(375);
  assert.equal(await angle.inputValue(), '40');
  await page.keyboard.up(']');
  await page.clock.runFor(500);
  assert.equal(await angle.inputValue(), '40');
  await page.keyboard.down('[');
  assert.equal(await angle.inputValue(), '39');
  await page.clock.runFor(650);
  assert.equal(await angle.inputValue(), '36');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.clock.runFor(500);
  assert.equal(await angle.inputValue(), '36');
  await page.keyboard.up('[');
  await page.keyboard.press('[');
  await page.clock.runFor(500);
  assert.equal(await angle.inputValue(), '35');
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
  await page.getByRole('button', {name:'Color 2', exact:true}).click();
  await page.locator('#view').selectOption('Top');
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    window.fillSearches = 0;
    Worker.prototype.postMessage = function(message, ...args) {
      if ('seed' in message) window.fillSearches++;
      return post.call(this, message, ...args);
    };
  });
  await page.locator('[data-tool="Fill"]').click();
  const canvas = await page.locator('#viewport > canvas').boundingBox();
  const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
  const started = performance.now();
  await page.mouse.move(cx, cy);
  await page.locator('#fill-highlight').waitFor({ state: 'visible' });
  t.diagnostic('First hover on the connected 1.5M-triangle grid: ' + Math.round(performance.now() - started) + ' ms');
  await page.mouse.move(cx + 40, cy, { steps: 12 });
  assert.ok(await page.locator('#dirty').isHidden());
  assert.ok(await page.locator('#undo').isDisabled());
  await page.mouse.click(cx + 40, cy);
  assert.equal(await page.evaluate(() => window.fillSearches), 1, 'hover movement and click reuse the same region');
  await click('save');
  assert.ok(readProject(await fs.readFile(projectFile)).paint.every(slot => slot === 1));
  await click('undo');
  await click('save');
  assert.deepEqual(readProject(await fs.readFile(projectFile)).paint, saved.paint);
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

test('rapid opacity changes import the final mask, retain PNG bytes and reuse the stamp thumbnail', async t => {
  const {page, click, projectFile} = await desktop(t);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#DE7248';
    ctx.fillRect(0, 0, 64, 128);
    ctx.globalAlpha = 0.4;
    ctx.fillRect(64, 0, 64, 128);
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('[data-tool="Stamps"]').click();
  const bytes = Buffer.from(png, 'base64');
  await page.locator('#image-input').setInputFiles({ name:'Opacity.png', mimeType:'image/png', buffer:bytes });
  await page.locator('#mapping[open]').waitFor();
  await page.locator('#stamp-opacity').evaluate(control => {
    for (const value of [0, 100, 10, 85]) {
      control.value = value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (!document.getElementById('confirm-import').disabled) throw Error('Stale conversion can be accepted');
  });
  await click('confirm-import');
  await click('save');
  const project = readProject(await fs.readFile(projectFile));
  assert.deepEqual(Buffer.from(project.stamps[0].source), bytes);
  assert.equal(project.stamps[0].pixels.filter(slot => slot === 255).length, 64 * 128);
  const thumb = page.locator('.stamp-choice canvas');
  const handle = await thumb.elementHandle();
  await page.locator('.stamp-choice').click();
  await page.locator('[data-tool="Brush"]').click();
  await page.locator('#viewport > canvas').click();
  await click('undo');
  assert.ok(await thumb.evaluate((current, original) => current === original, handle));
});

test('pixel stamp resizing shows the artwork while dragging and refines once on release', async (t) => {
  const { app, page, click, projectFile } = await desktop(t);
  const project = readSTL(fixture(), 'Stamp resize.stl');
  project.stamps = [{ name:'Ink', width:2, height:1, pixels:Uint8Array.of(1,1),
    source:Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64')) }];
  const slider = page.locator('#stamp-size');
  const waitForPreview = () => page.waitForFunction(() => !document.getElementById('apply').disabled);
  const profiler = await page.context().newCDPSession(page);
  await profiler.send('Profiler.enable');
  await profiler.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  async function refinementsSinceLastCheck() {
    const { result } = await profiler.send('Profiler.takePreciseCoverage');
    return result.flatMap(script => script.functions)
      .filter(fn => fn.functionName === 'projectFootprint')
      .reduce((total, fn) => total + fn.ranges[0].count, 0);
  }
  async function visibleInkPixels() {
    const clip = await page.locator('#stamp-outline').boundingBox();
    return app.evaluate(async ({ BrowserWindow }, clip) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(clip);
      const bgra = image.toBitmap();
      let orange = 0;
      for (let i = 0; i < bgra.length; i += 4) {
        if (bgra[i + 2] > bgra[i + 1] * 1.4 && bgra[i + 2] > bgra[i] * 1.5) orange++;
      }
      return orange;
    }, Object.fromEntries(Object.entries(clip).map(([name, value]) => [name, Math.round(value)])));
  }
  for (const refine of [false, true]) {
    await fs.writeFile(projectFile, writeProject(project));
    await click('open');
    await page.locator('[data-tool="Stamps"]').click();
    await page.locator('.stamp-choice').click();
    await page.locator('#refine-stamp').setChecked(refine);
    await waitForPreview();
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox(), y = box.y + box.height / 2;
    await refinementsSinceLastCheck();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true));
    await page.mouse.move(box.x + box.width * 0.12, y);
    await page.mouse.down();
    const ink = [];
    for (const fraction of [0.06, 0.15, 0.09]) {
      await page.mouse.move(box.x + box.width * fraction, y);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const width = await slider.inputValue();
      assert.equal(await page.locator('#stamp-size-value').innerText(), width + ' px');
      assert.equal(await page.locator('#stamp-outline').evaluate(el => el.style.width), width + 'px');
      assert.ok(await page.locator('#apply').isDisabled());
      ink.push(await visibleInkPixels());
    }
    assert.ok(ink[0] > 0 && ink[1] > ink[2] && ink[2] > ink[0], 'visible ink grows and shrinks: ' + ink);
    assert.equal(await refinementsSinceLastCheck(), 0);
    await page.mouse.move(box.x + box.width * 0.09, y - 35);
    await page.mouse.up();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(false));
    await waitForPreview();
    assert.equal(await refinementsSinceLastCheck(), refine ? 1 : 0);
    const width = await slider.inputValue();
    await slider.press('ArrowRight');
    await page.waitForFunction(w => document.getElementById('stamp-outline').style.width === w + 'px', Number(width) + 1);
    await click('apply');
    await click('save');
    const stamped = readProject(await fs.readFile(projectFile));
    assert.ok(stamped.paint.includes(1));
    assert.equal(stamped.editingContext.sizes.stamp.px, Number(width) + 1);
    assert.equal(!!stamped.splits, refine);
  }
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
