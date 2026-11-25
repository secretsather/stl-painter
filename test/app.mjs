import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { PerspectiveCamera, Vector3 } from 'three';
import { readProject } from '../src/files.js';
import { bounds, makeSurface } from '../src/mesh.js';
import { fixture } from './fixture.mjs';
import { checkStampEdges } from './stamp-edges.mjs';
import { checkStrokeEdges } from './stroke-edges.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stl-painter-app-'));
const stl = path.join(dir, 'Beveled slab.stl'),
  file = path.join(dir, 'Edited.stlp'),
  out = path.join(dir, 'Painted.3mf'),
  art = path.join(dir, 'Ring.png');
await fs.writeFile(stl, fixture());
let app, page;
const errors = [];
async function launch() {
  app = await _electron.launch({
    args: [
      ...(process.env.PAINTER_EXE ? [] : ['.']),
      '--user-data-dir=' + path.join(dir, 'profile'),
    ],
    ...(process.env.PAINTER_EXE ? { executablePath: process.env.PAINTER_EXE } : {}),
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(10000);
  await page.locator('#faces').filter({ hasText: 'source triangles' }).waitFor();
  await page.context().setOffline(true);
  await app.evaluate(
    ({ dialog }, paths) => {
      global.testDialogs = { ...paths, open: paths.stl, choice: 1 };
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [global.testDialogs.open],
      });
      dialog.showSaveDialog = async (_, opts) => ({
        canceled: !!global.testDialogs.cancelSave,
        filePath:
          opts.filters[0].extensions[0] === '3mf'
            ? global.testDialogs.out
            : global.testDialogs.file,
      });
      dialog.showMessageBox = async () => ({ response: global.testDialogs.choice });
    },
    { stl, file, out }
  );
}
const click = (id) => page.locator('#' + id).click();
async function waitIdle() {
  await page.locator('#busy').waitFor({ state: 'hidden' });
  assert.equal(
    await page.locator('#notice').isVisible(),
    false,
    await page.locator('#notice-text').textContent()
  );
}
async function save() {
  await click('save');
  await waitIdle();
  return readProject(new Uint8Array(await fs.readFile(file)));
}
async function expectSavedProject(expected, message) {
  // A failed diff of a subdivided mesh can contain millions of entries.
  assert.ok(isDeepStrictEqual(await save(), expected), message);
}
async function range(id, value) {
  await page.locator('#' + id).evaluate((e, v) => {
    e.value = v;
    e.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
}
async function color(n, hex) {
  const row = page.locator('.swatch-row').nth(n - 1);
  await row.getByLabel('Edit Color ' + n, { exact: true }).fill(hex);
  assert.equal(await row.locator('.palette-hex').innerText(), hex.toUpperCase());
}
const chooseTool = (name) => page.locator('[data-tool="' + name + '"]').click();
const chooseColor = (n) =>
  page
    .locator('.swatch-row button[aria-pressed]')
    .nth(n - 1)
    .click();
async function end() {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    app = null;
  }
}
try {
  await launch();
  const cube = page.getByRole('group', { name: 'View cube' });
  const face = (name) => cube.getByRole('button', { name: name + ' view' });
  const modelCanvas = page.locator('#viewport > canvas');
  const viewportBox = await modelCanvas.boundingBox();
  const cx = viewportBox.x + viewportBox.width / 2,
    cy = viewportBox.y + viewportBox.height / 2;
  assert.deepEqual(await cube.getByRole('button').allTextContents(), [
    'Front viewFront',
    'Right viewRight',
    'Top viewTop',
  ]);
  const initial = await face('Front').getAttribute('transform');
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 18, cy - 14, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  assert.notEqual(await face('Front').getAttribute('transform'), initial);
  assert.equal(await page.locator('#view').inputValue(), 'Custom');
  await click('projection');
  for (const name of ['Front', 'Right', 'Back', 'Left', 'Top', 'Bottom']) {
    await page.locator('#view').selectOption(name);
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    // Tilt toward the equator when starting at either pole.
    await page.mouse.move(cx + 20, cy + (name === 'Top' ? -18 : 18), { steps: 4 });
    await page.mouse.up({ button: 'right' });
    assert.equal(await page.locator('#view').inputValue(), 'Custom');
    await face(name).click();
    assert.equal(await page.locator('#view').inputValue(), name);
    assert.equal(await face(name).getAttribute('aria-pressed'), 'true');
    assert.equal(await cube.getByRole('button').count(), 1);
  }
  assert.equal(await page.locator('#projection').textContent(), 'Orthographic');
  await page.locator('#view').selectOption('Front');
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -140);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 38, cy + 21, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  const centerClip = { x: cx - 100, y: cy - 110, width: 200, height: 220 };
  const framedModel = await page.screenshot({ clip: centerClip });
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 60, cy + 38, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await face('Front').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#view').value === 'Front');
  assert.ok(
    (await page.screenshot({ clip: centerClip })).equals(framedModel),
    'snap preserves pan and zoom'
  );
  assert.equal(await page.locator('#dirty').isVisible(), false);
  await checkStampEdges({ page, chooseTool, range, click, save });
  await click('projection');
  await checkStrokeEdges({
    page,
    app,
    file: path.join(dir, 'Thin facets.stlp'),
    chooseTool,
    range,
    open: async () => {
      await click('open');
      await waitIdle();
    },
    save: async () => {
      await click('save');
      await waitIdle();
    },
  });
  await app.evaluate(() => {
    global.testDialogs.open = global.testDialogs.stl;
  });
  await click('open');
  await waitIdle();
  assert.equal(await page.locator('#model-name').textContent(), 'Beveled slab');
  const version = await app.evaluate(({ app }) => app.getVersion());
  const windowTitle = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  const slabTitle = 'Beveled slab — STL Painter v' + version;
  assert.equal(await windowTitle(), slabTitle);
  await page.locator('#view').selectOption('Top');
  await click('projection');
  const canvas = page.locator('#viewport > canvas'),
    box = await canvas.boundingBox();
  const scale =
    box.height /
    (2 *
      Math.hypot(95, 52, 12) *
      1.75 *
      Math.max(1, box.height / box.width) *
      Math.tan((35 * Math.PI) / 360));
  const point = (x, y) => [
    box.x + box.width / 2 + (x - 7.5) * scale,
    box.y + box.height / 2 - y * scale,
  ];
  await range('brush-size', 12);
  const bare = await save();
  await page.mouse.move(...point(-8, -8));
  await page.mouse.down();
  await page.keyboard.press('Control+z');
  await page.mouse.up();
  await expectSavedProject(bare, 'Ctrl+Z can undo the first stroke while the mouse is held');
  // Straddle the silhouette in a snapped orthographic view. Only the top
  // has visible area here, even though the brush overlaps the wall in 2D.
  await page.mouse.click(...point(0, -26));
  assert.equal(await windowTitle(), '• ' + slabTitle);
  const rim = await save();
  assert.equal(await windowTitle(), slabTitle);
  const rimSurface = makeSurface(rim);
  let wallCells = 0,
    topCells = 0;
  rim.paint.forEach((color, cell) => {
    if (!color) return;
    if (rimSurface.normals[rimSurface.owners[cell] * 3 + 2] > 0.99) topCells++;
    else wallCells++;
  });
  assert.ok(topCells > 0, 'orthographic brush paints the visible top rim');
  assert.equal(wallCells, 0, 'orthographic brush speckled the edge-on wall');
  const colorLimit = page.getByLabel('Colors per horizontal slice');
  const sliceStatus = page.locator('#viewport #slice-status');
  const warningIcon = sliceStatus.locator('svg');
  assert.ok(await colorLimit.isHidden());
  await sliceStatus.click();
  assert.equal(await colorLimit.inputValue(), '4');
  await colorLimit.selectOption('1');
  const conflict = page.locator('#color-limit-report.warning');
  await conflict.filter({ hasText: '2 colors at Z' }).waitFor();
  assert.ok(await warningIcon.isVisible());
  const badge = await sliceStatus.boundingBox();
  const area = await modelCanvas.boundingBox();
  const details = await page.locator('#slice-details').boundingBox();
  assert.ok(Math.abs(badge.x - area.x - 16) < 1);
  assert.ok(Math.abs(area.y + area.height - badge.y - badge.height - 16) < 1);
  assert.ok(Math.abs(details.x - badge.x) < 1 && Math.abs(details.y + details.height + 6 - badge.y) < 1);
  assert.deepEqual(await conflict.locator('#color-limit-colors span').allTextContents(), [
    'Color 1',
    'Color 2',
  ]);
  await page.keyboard.press('Escape');
  assert.ok(await colorLimit.isHidden());
  assert.match(await sliceStatus.innerText(), /2 used \/ 1 allowed/);
  await page.keyboard.press('Control+z');
  await expectSavedProject(bare);
  await sliceStatus.click();
  await page
    .locator('#color-limit-summary')
    .filter({ hasText: 'Within the selected color limit' })
    .waitFor();
  await colorLimit.selectOption('0');
  assert.ok(await warningIcon.isHidden());
  assert.ok(await page.locator('#color-limit-report').isHidden());
  await page.keyboard.press('Escape');
  assert.match(await sliceStatus.innerText(), /off/);
  await page.locator('#view').selectOption('Front');
  await page.mouse.click(cx, cy);
  const front = await save();
  assert.ok(
    front.paint.some((c) => c !== 0),
    'the same wall can be painted from the front'
  );
  const frontSurface = makeSurface(front);
  assert.ok(
    front.paint.every((c, i) => !c || frontSurface.normals[frontSurface.owners[i] * 3 + 1] < -0.99)
  );
  await click('undo');
  await page.locator('#view').selectOption('Top');
  await page.mouse.move(...point(-24, 4));
  await page.mouse.down();
  await page.mouse.move(...point(23, 4), { steps: 8 });
  await page.mouse.up();
  const brushed = await save();
  const brushSurface = makeSurface(brushed);
  const facesPainted = new Set();
  brushed.paint.forEach((c, i) => {
    if (c) facesPainted.add(brushSurface.owners[i]);
  });
  assert.deepEqual([...facesPainted].sort(), [6, 7]);
  assert.ok(brushed.paint.includes(0));
  await chooseTool('Eraser');
  await page.mouse.click(...point(-12, 4));
  const erasedStroke = await save();
  await page.keyboard.press('Control+z');
  await expectSavedProject(brushed);
  await page.keyboard.press('Control+Shift+z');
  await expectSavedProject(erasedStroke);
  const basePicker = page.getByLabel('Edit Color 1', { exact: true });
  await basePicker.click();
  assert.ok(
    await basePicker.evaluate((input) => input.matches(':open')),
    'clicking the swatch opens its picker'
  );
  assert.equal(
    await page
      .getByRole('button', { name: 'Color 1 (base)', exact: true })
      .getAttribute('aria-pressed'),
    'true'
  );
  await page.keyboard.press('Escape');
  await color(1, '#AABBCD');
  const erased = await save();
  assert.equal(erased.palette[0], '#AABBCD');
  const surface = makeSurface(erased);
  const nearestStripeColor = (project, geometry) => {
    let best = Infinity,
      color;
    for (let i = 0; i < project.paint.length; i++) {
      if (![6, 7].includes(geometry.owners[i])) continue;
      const k = i * 9,
        xyz = geometry.positions;
      const d = Math.hypot(
        (xyz[k] + xyz[k + 3] + xyz[k + 6]) / 3 + 12,
        (xyz[k + 1] + xyz[k + 4] + xyz[k + 7]) / 3 - 4
      );
      if (d < best) {
        best = d;
        color = project.paint[i];
      }
    }
    return color;
  };
  assert.equal(nearestStripeColor(brushed, brushSurface), 1);
  assert.equal(nearestStripeColor(erased, surface), 0);
  await chooseColor(2);
  await color(2, '#3265AB');
  await page.keyboard.press('Control+z');
  assert.equal(
    await page.locator('.palette-hex').nth(1).innerText(),
    erased.palette[1].toUpperCase()
  );
  await click('redo');
  assert.equal(await page.locator('.palette-hex').nth(1).innerText(), '#3265AB');
  const edited = await save();
  assert.deepEqual(edited.paint, erased.paint);
  await chooseTool('Stamps');
  const uri = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 40;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(237,18,103,0.8)';
    ctx.fillRect(0, 0, 40, 40);
    ctx.clearRect(10, 10, 20, 20);
    ctx.fillStyle = 'rgba(0,0,0,0.01)';
    ctx.fillRect(10, 10, 20, 20);
    ctx.clearRect(15, 15, 1, 1);
    return c.toDataURL();
  });
  await fs.writeFile(art, Buffer.from(uri.split(',')[1], 'base64'));
  await page.locator('#image-input').setInputFiles(art);
  await page.locator('#mapping[open]').waitFor();
  const previewInk = () =>
    page.locator('#mapping-preview canvas').evaluate((canvas) => {
      const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) ink++;
      return ink;
    });
  assert.equal(await page.locator('#stamp-opacity').inputValue(), '50');
  assert.equal(await previewInk(), 1200);
  const previewCanvas = page.locator('#mapping-preview canvas');
  const fitted = await previewCanvas.boundingBox();
  assert.ok(fitted.height > 200);
  const pointerX = fitted.x + fitted.width * 0.65;
  const pointerY = fitted.y + fitted.height * 0.4;
  await page.mouse.move(pointerX, pointerY);
  await page.mouse.wheel(0, -250);
  await page.waitForFunction((width) => document.querySelector('#mapping-preview canvas').getBoundingClientRect().width > width, fitted.width);
  const zoomed = await previewCanvas.boundingBox();
  assert.ok(Math.abs(zoomed.x + zoomed.width * 0.65 - pointerX) < 1);
  assert.ok(Math.abs(zoomed.y + zoomed.height * 0.4 - pointerY) < 1);
  await page.mouse.down();
  await page.mouse.move(pointerX + 30, pointerY + 20);
  await page.mouse.up();
  const panned = await previewCanvas.boundingBox();
  assert.ok(Math.abs(panned.x - zoomed.x - 30) < 1);
  assert.ok(Math.abs(panned.y - zoomed.y - 20) < 1);
  const transform = () => previewCanvas.evaluate((canvas) => canvas.style.transform);
  const inspected = await transform();
  const removed = page.getByRole('checkbox', { name: 'Show removed pixels' });
  assert.equal(await removed.isChecked(), false);
  await removed.check();
  assert.equal(await previewInk(), 1599);
  assert.equal(await transform(), inspected);
  await removed.uncheck();
  await range('stamp-opacity', 0);
  assert.equal(await previewInk(), 1599);
  assert.equal(await transform(), inspected);
  await range('stamp-opacity', 100);
  assert.equal(await previewInk(), 0);
  assert.ok(await page.locator('#confirm-import').isDisabled());
  assert.ok(await page.locator('#empty-mask').isVisible());
  await removed.check();
  assert.equal(await previewInk(), 1599);
  assert.ok(await page.locator('#confirm-import').isDisabled());
  await range('stamp-opacity', 50);
  await click('fit-artwork');
  assert.deepEqual(await previewCanvas.boundingBox(), fitted);
  await page.locator('#mapping-mode').selectOption('add');
  await range('limit', 1);
  await click('confirm-import');
  const added = await save();
  assert.equal(added.palette.length, 5);
  assert.equal(added.stamps[0].pixels.filter((i) => i !== 255).length, 1200);
  await page.locator('#apply:enabled').waitFor();
  const outline = page.locator('#stamp-outline');
  await range('stamp-size', 40);
  await range('rotation', 25);
  const canvasBox = await modelCanvas.boundingBox();
  const blankX = canvasBox.x + canvasBox.width - 40;
  const blankY = canvasBox.y + canvasBox.height - 90;
  await page.mouse.click(blankX, blankY);
  await page.waitForFunction(([x, y]) => {
    const box = document.querySelector('#stamp-outline').getBoundingClientRect();
    return Math.abs(box.x + box.width / 2 - x) < 1 && Math.abs(box.y + box.height / 2 - y) < 1
      && document.querySelector('#apply').disabled;
  }, [blankX, blankY]);
  const outlineBox = await outline.boundingBox();
  assert.ok(Math.abs(outlineBox.x + outlineBox.width / 2 - blankX) < 1);
  assert.ok(Math.abs(outlineBox.y + outlineBox.height / 2 - blankY) < 1);
  assert.ok(Math.abs(outlineBox.width - 40 * (Math.cos(25 * Math.PI / 180) + Math.sin(25 * Math.PI / 180))) < 1);
  await page.keyboard.press('Escape');
  assert.ok(await outline.isHidden());
  assert.equal(await page.locator('#tool-title').textContent(), 'Brush');
  assert.ok(await page.locator('#apply').isDisabled());
  assert.ok(await page.locator('#viewport > canvas').evaluate((canvas) => canvas === document.activeElement));
  await expectSavedProject(added, 'canceling stamp placement preserves the paint and the imported stamp');
  await chooseTool('Stamps');
  const importedStamp = page.locator('.stamp-choice');
  assert.equal(await importedStamp.getAttribute('aria-pressed'), 'false');
  await page.mouse.click(cx, cy);
  assert.ok(await outline.isHidden());
  assert.ok(await page.locator('#placement').isHidden());
  await importedStamp.click();
  assert.equal(await importedStamp.getAttribute('aria-pressed'), 'true');
  await page.locator('#apply:enabled').waitFor();
  await page.keyboard.press('Control+z');
  await expectSavedProject(edited, 'undoing the import also removes its preview and new colors');
  await page.keyboard.press('Control+y');
  await expectSavedProject(added);
  await range('stamp-size', Math.round(24 * scale));
  await range('rotation', 25);
  await page.mouse.click(...point(0, -26));
  await page.locator('#apply:enabled').waitFor();
  await click('apply');
  const rimStamp = await save();
  const rimStampSurface = makeSurface(rimStamp);
  assert.ok(rimStamp.paint.includes(4));
  assert.ok(
    rimStamp.paint.every(
      (c, i) => c !== 4 || rimStampSurface.normals[rimStampSurface.owners[i] * 3 + 2] > 0.99
    ),
    'a stamp crossing the rim must leave edge-on walls clean even with its angle filter off'
  );
  await click('undo');
  await page.mouse.click(...point(30, -8));
  await page.locator('#apply:enabled').waitFor();
  await click('apply');
  const unfiltered = await save();
  const unfilteredSurface = makeSurface(unfiltered);
  await page.keyboard.press('Control+z');
  await expectSavedProject(added);
  assert.ok(
    unfiltered.paint.some((c, i) => c === 4 && [4, 5].includes(unfilteredSurface.owners[i])),
    'bevel receives unfiltered stamp'
  );
  await page.locator('#filter').check();
  await range('cutoff', 10);
  await page.locator('#apply:enabled').waitFor();
  await page.waitForTimeout(120);
  const [left, top] = point(-45, 30),
    [right, bottom] = point(60, -30);
  const clip = { x: left, y: top, width: right - left, height: bottom - top };
  async function verifyPlacementDrag(clip, [x, y]) {
    // Keep the physical pointer from interrupting Playwright's held drag.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true)
    );
    async function frame() {
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      return page.screenshot({ clip, style: '#stamp-outline { visibility: hidden }' });
    }
    await page.mouse.click(x, y);
    await page.locator('#apply:enabled').waitFor();
    const final = await frame();
    await page.mouse.move(x - 24, y - 16);
    await page.mouse.down();
    const first = await frame();
    await page.mouse.move(x, y, { steps: 4 });
    const moving = await frame();
    assert.ok(!moving.equals(first), 'rough preview follows the pointer');
    assert.ok(!moving.equals(final), 'drag uses a coarse preview at the destination');
    assert.ok(await page.locator('#apply').isDisabled());
    await page.keyboard.press('Enter');
    await page.mouse.up();
    await page.locator('#apply:enabled').waitFor();
    assert.ok((await frame()).equals(final), 'release restores exact preview at the destination');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(false)
    );
    return final;
  }
  const preview = await verifyPlacementDrag(clip, point(30, -8));
  await click('apply');
  assert.ok(await outline.isHidden());
  await page.waitForTimeout(120);
  const applied = await page.screenshot({ clip });
  assert.ok(applied.equals(preview), 'applied surface matches preview pixel for pixel');
  const stamped = await save();
  const originalName = stamped.stamps[0].name;
  const removeStamp = (name) => page.getByRole('button', { name: 'Remove stamp ' + name, exact: true });
  await page.getByRole('button', { name: originalName, exact: true }).click();
  await outline.waitFor();
  await removeStamp(originalName).click();
  assert.ok(await outline.isHidden());
  assert.ok(await page.locator('#placement').isHidden());
  const withoutStamp = { ...stamped, stamps: [] };
  await expectSavedProject(withoutStamp, 'removing the active stamp preserves applied paint and palette');
  await click('undo');
  await expectSavedProject(stamped);
  await click('redo');
  await expectSavedProject(withoutStamp);
  await click('undo');
  await page.locator('#image-input').setInputFiles({
    name: 'Second stamp.png', mimeType: 'image/png', buffer: await fs.readFile(art),
  });
  await click('confirm-import');
  await outline.waitFor();
  await removeStamp(originalName).click();
  assert.equal(await page.locator('.stamp-choice[aria-pressed="true"]').innerText(), 'Second stamp.png');
  assert.ok(await outline.isVisible());
  await click('undo');
  assert.deepEqual(await page.locator('.stamp-choice').allTextContents(), [originalName, 'Second stamp.png']);
  await click('undo');
  await expectSavedProject(stamped);
  const removeColor = (n) => page.getByRole('button', { name: 'Remove Color ' + n, exact: true });
  const removeDialog = page.locator('#remove-color-dialog');
  assert.ok(await removeColor(1).isVisible());
  await click('add-color');
  await color(2, '#3167B2');
  await removeColor(6).click();
  assert.ok(await removeDialog.isHidden());
  await expectSavedProject({ ...stamped, palette: stamped.palette.map((hex, i) => i === 1 ? '#3167B2' : hex) },
    'removing an unused color preserves later edits');
  await click('undo');
  await click('undo');
  await click('undo');
  await expectSavedProject(stamped);
  await removeColor(5).click();
  await removeDialog.getByRole('button', { name: 'Cancel' }).click();
  await expectSavedProject(stamped);
  const replaceColor = async (from, to) => {
    await removeColor(from).click();
    await removeDialog.getByLabel('Replace with').selectOption(String(to - 1));
    await removeDialog.getByRole('button', { name: 'Replace and remove' }).click();
    await removeDialog.waitFor({ state: 'hidden' });
  };
  for (const [from, to] of [[2, 5], [5, 2], [1, 5]]) {
    await replaceColor(from, to);
    const expected = structuredClone(stamped);
    const hex = expected.palette.splice(from - 1, 1)[0];
    if (from === 1) {
      const nextBase = stamped.palette[to - 1];
      expected.palette = [nextBase, ...expected.palette.filter((color) => color !== nextBase)];
    }
    const remap = (i) => {
      if (i === 255) return i;
      const color = i === from - 1 ? stamped.palette[to - 1] : stamped.palette[i];
      return expected.palette.indexOf(color);
    };
    expected.paint = expected.paint.map(remap);
    for (const stamp of expected.stamps) stamp.pixels = stamp.pixels.map(remap);
    await expectSavedProject(expected, 'removed ' + hex + ' from the painted model and stamp library');
    await click('undo');
    await expectSavedProject(stamped);
    await click('redo');
    await expectSavedProject(expected);
    await click('undo');
  }
  await replaceColor(1, 5);
  for (let n = 4; n >= 2; n--) {
    await removeColor(n).click();
    if (await removeDialog.isVisible()) {
      await removeDialog.getByRole('button', { name: 'Replace and remove' }).click();
      await removeDialog.waitFor({ state: 'hidden' });
    }
  }
  const single = await save();
  assert.deepEqual(single.palette, [stamped.palette[4]]);
  assert.ok(single.paint.every((index) => index === 0));
  assert.ok(single.stamps[0].pixels.every((index, i) => index === (stamped.stamps[0].pixels[i] === 255 ? 255 : 0)));
  assert.equal(await removeColor(1).count(), 0);
  await click('add-color');
  assert.ok(await removeColor(1).isVisible());
  for (let i = 0; i < 5; i++) await click('undo');
  await expectSavedProject(stamped);
  const stampedSurface = makeSurface(stamped);
  assert.ok(stamped.paint.includes(4));
  assert.ok(
    stamped.paint.every((c, i) => c !== 4 || [6, 7].includes(stampedSurface.owners[i])),
    'front cutoff rejects bevel and far side'
  );
  const pos = stampedSurface.positions;
  stamped.paint.forEach((c, i) => {
    const x = (pos[i * 9] + pos[i * 9 + 3] + pos[i * 9 + 6]) / 3,
      y = (pos[i * 9 + 1] + pos[i * 9 + 4] + pos[i * 9 + 7]) / 3;
    if (Math.hypot(x - 30, y + 8) < 3) assert.notEqual(c, 4, 'transparent opening');
  });
  await chooseTool('Fill');
  await chooseColor(3);
  await range('angle', 35);
  await page.mouse.click(...point(-27, -14));
  const protect = await save();
  const protectSurface = makeSurface(protect);
  assert.ok(protect.paint.includes(4));
  assert.ok(protect.paint.includes(1));
  assert.ok(protect.paint.includes(2));
  assert.ok(
    protect.paint.every((c, i) => c !== 2 || [4, 5, 6, 7].includes(protectSurface.owners[i])),
    'protected fill stops at sharp edges and disconnected piece'
  );
  await page.locator('#protect').uncheck();
  await chooseColor(4);
  await page.mouse.click(...point(-27, -14));
  const override = await save();
  assert.ok(!override.paint.includes(4));
  assert.ok(!override.paint.includes(1));
  await page.keyboard.press('Control+z');
  await expectSavedProject(protect);
  await click('redo');
  assert.deepEqual((await save()).paint, override.paint);
  await click('undo');
  const original = await save();
  await fs.rename(stl, stl + '.moved');
  await fs.rename(art, art + '.moved');
  await app.close();
  app = null;
  await launch();
  await app.evaluate(() => {
    global.testDialogs.open = global.testDialogs.file;
  });
  await click('open');
  await waitIdle();
  await expectSavedProject(original);
  await chooseTool('Stamps');
  assert.equal(await page.locator('.stamp-choice').count(), 1);
  await page.locator('.stamp-choice').click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('#apply:enabled').waitFor();
  await click('apply');
  const resumed = await save();
  const resumedSurface = makeSurface(resumed);
  assert.notDeepEqual(resumed.paint, original.paint);
  // Inspect the solid part of the second ring at an oblique angle. Every visible
  // top cell there must receive ink, including cells smaller than a screen pixel.
  const camera = new PerspectiveCamera(35, box.width / box.height, 0.01, 10000);
  const center = new Vector3(7.5, 0, 6);
  camera.up.set(0, 0, 1);
  camera.position
    .copy(center)
    .add(new Vector3(1, -1.65, 0.89).setLength(Math.hypot(95, 52, 12) * 1.75));
  camera.lookAt(center);
  camera.updateMatrixWorld();
  let interior = 0;
  for (let id = 0; id < resumed.paint.length; id++) {
    if (![6, 7].includes(resumedSurface.owners[id])) continue;
    const pos = resumedSurface.positions;
    const k = id * 9;
    const point = new Vector3(
      ...[0, 1, 2].map((j) => (pos[k + j] + pos[k + 3 + j] + pos[k + 6 + j]) / 3)
    ).project(camera);
    const offset = Math.max(
      Math.abs((point.x * box.width) / 2),
      Math.abs((point.y * box.height) / 2)
    );
    if (offset > 44 && offset < 76) {
      interior++;
      assert.equal(resumed.paint[id], 4, 'solid stamp interior has a pinhole');
    }
  }
  assert.ok(interior > 100);
  // Type in the perspective view without triggering tool or
  // history shortcuts, then verify the same paint survives saving and export.
  const textCanvas = page.locator('#viewport > canvas');
  await textCanvas.focus();
  await page.keyboard.press('t');
  const content = page.getByLabel('Text to paint');
  assert.ok(await content.evaluate((el) => el === document.activeElement));
  await content.pressSequentially('Draft');
  await content.press('Control+z');
  assert.equal(await content.inputValue(), '', 'Ctrl+Z edits the focused text draft');
  await expectSavedProject(resumed, 'undoing typing preserves the previous model edit');
  await content.focus();
  await content.pressSequentially('Best');
  await content.press('Enter');
  await content.pressSequentially('Fit');
  assert.equal(await content.inputValue(), 'Best\nFit');
  assert.equal(await page.locator('#tool-title').textContent(), 'Text');
  assert.ok(await page.getByLabel('Refine text edges').isChecked());
  const font = page.getByLabel('Font', { exact: true });
  await font.selectOption('Georgia');
  console.log('Available text font families:', await font.locator('option').count());
  await range('text-size', 24);
  await chooseColor(4);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('#apply:enabled').waitFor();
  const textClip = {
    x: box.x + box.width / 2 - 85,
    y: box.y + box.height / 2 - 75,
    width: 170,
    height: 150,
  };
  async function textPreview() {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    return page.screenshot({ clip: textClip });
  }
  const serif = await textPreview();
  await content.press('Escape');
  assert.equal(await page.locator('#tool-title').textContent(), 'Brush');
  assert.ok(await textCanvas.evaluate((el) => el === document.activeElement));
  assert.ok(!(await textPreview()).equals(serif), 'Escape removes the lettering preview');
  assert.equal(await page.locator('#dirty').isVisible(), false);
  await expectSavedProject(resumed);
  await chooseTool('Text');
  assert.equal(await content.inputValue(), 'Best\nFit');
  await font.selectOption('Consolas');
  assert.ok(!(await textPreview()).equals(serif), 'font changes the projected lettering');
  await page.getByLabel('Bold', { exact: true }).check();
  await page.getByLabel('Italic', { exact: true }).check();
  await page.getByLabel('Line alignment').selectOption('center');
  await range('rotation', 15);
  assert.deepEqual(
    (await save()).paint,
    resumed.paint,
    'a text preview does not alter saved paint'
  );
  const lettering = await verifyPlacementDrag(textClip, [
    box.x + box.width / 2,
    box.y + box.height / 2,
  ]);
  await textCanvas.focus();
  await page.keyboard.press('Enter');
  const lettered = await save();
  assert.ok((await textPreview()).equals(lettering), 'applied text matches the preview');
  assert.notDeepEqual(lettered.paint, resumed.paint);
  await textCanvas.press('Escape');
  assert.equal(await page.locator('#tool-title').textContent(), 'Brush');
  await expectSavedProject(lettered, 'exiting after Apply keeps the lettering');
  await page.keyboard.press('Control+z');
  await expectSavedProject(resumed);
  await click('redo');
  await expectSavedProject(lettered);
  await chooseTool('Text');
  await content.fill('   ');
  await page.locator('#apply:disabled').waitFor();
  await click('open');
  await waitIdle();
  await expectSavedProject(lettered, 'text paint survives reopening the project');
  await click('export');
  await waitIdle();
  const exported = unzipSync(new Uint8Array(await fs.readFile(out)));
  const config = JSON.parse(strFromU8(exported['Metadata/project_settings.config']));
  assert.deepEqual(
    config.filament_colour,
    [...new Set(lettered.paint)].sort().map((i) => lettered.palette[i])
  );
  if (process.env.SLICER_EXE) {
    const result = spawnSync(
      process.env.SLICER_EXE,
      ['--export-3mf', 'Reopened.3mf', 'Painted.3mf'],
      { cwd: dir, timeout: 90000, windowsHide: true }
    );
    assert.equal(result.status, 0, result.error?.message);
    const archive = unzipSync(new Uint8Array(await fs.readFile(path.join(dir, 'Reopened.3mf'))));
    const reconfig = JSON.parse(strFromU8(archive['Metadata/project_settings.config']));
    assert.deepEqual(reconfig.filament_colour, config.filament_colour);
    const xml = strFromU8(
      archive[Object.keys(archive).find((k) => k.endsWith('.model') && k.includes('/Objects/'))]
    );
    const paintStrings = (text) => [...text.matchAll(/paint_color="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(paintStrings(xml), paintStrings(strFromU8(exported['3D/3dmodel.model'])));
    const coords = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].flatMap((m) =>
      m.slice(1).map(Number)
    );
    assert.deepEqual(bounds(coords).size, [95, 52, 12]);
    console.log(
      'Slicer round-trip passed for dimensions, all facet paint trees and filament slots.'
    );
  }
  // Cancelling a close or a Save As, and a failed write, must keep the edits.
  await click('add-color');
  await page.keyboard.press('Control+z');
  await expectSavedProject(lettered);
  const savedBytes = await fs.readFile(file);
  await page.keyboard.press('Control+y');
  await app.evaluate(({ BrowserWindow }) => {
    global.testDialogs.choice = 2;
    BrowserWindow.getAllWindows()[0].close();
  });
  await waitIdle();
  assert.ok(await page.locator('#dirty').isVisible());
  await app.evaluate(() => {
    global.testDialogs.cancelSave = true;
  });
  await click('save-as');
  await waitIdle();
  assert.ok((await fs.readFile(file)).equals(savedBytes));
  await app.evaluate(
    (_, dest) => {
      global.testDialogs.cancelSave = false;
      global.testDialogs.file = dest;
    },
    path.join(dir, 'missing-directory', 'copy.stlp')
  );
  await click('save-as');
  await page.locator('#notice[open]').waitFor();
  await page.locator('#notice button').click();
  assert.ok(await page.locator('#dirty').isVisible());
  assert.ok((await fs.readFile(file)).equals(savedBytes));
  await click('save');
  await waitIdle();
  assert.equal((await save()).palette.length, resumed.palette.length + 1);
  assert.deepEqual(errors, []);
  console.log('Offline desktop workflow passed. Artifacts: ' + dir);
} finally {
  await end();
}
