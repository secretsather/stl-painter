import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { newProject, makeSurface, bounds } from '../src/mesh.js';
import { readProject, writeProject } from '../src/files.js';

// Same 128-strip fixture and 36 px eraser used to measure the original spikes.
export async function checkStrokeEdges({ page, app, file, open, save, chooseTool, range }) {
  const vertices = [],
    faces = [];
  for (let i = 0; i <= 128; i++) {
    const x = -12 + (24 * i) / 128;
    vertices.push(x, -60, 0, x, 60, 0);
    if (i) {
      const a = 2 * i - 2;
      faces.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
  }
  const original = newProject('Thin facets', Float32Array.from(vertices), Uint32Array.from(faces));
  original.paint.fill(1);
  await fs.writeFile(file, writeProject(original));
  await app.evaluate((_, path) => {
    global.testDialogs.open = path;
  }, file);
  await open();
  await page.locator('#view').selectOption('Top');
  await page.locator('#projection').click();
  const toggle = page.getByRole('checkbox', { name: 'Refine stroke edges' });
  assert.ok(await toggle.isChecked());
  await toggle.uncheck();
  await chooseTool('Eraser');
  assert.equal(await toggle.isChecked(), false);
  await range('brush-size', 36);
  const box = await page.locator('#viewport > canvas').boundingBox();
  const scale =
    box.height /
    (2 *
      bounds(vertices).diagonal *
      1.75 *
      Math.max(1, box.height / box.width) *
      Math.tan((35 * Math.PI) / 360));
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2,
    y = Math.round(cy + 5);
  async function readArtwork() {
    const { editingContext, ...artwork } = readProject(new Uint8Array(await fs.readFile(file)));
    return artwork;
  }
  async function drag() {
    await page.mouse.move(cx - 15 * scale, y);
    await page.mouse.down();
    await page.mouse.move(cx + 15 * scale, y, { steps: 14 });
    await page.mouse.up();
    await save();
    return readArtwork();
  }
  function edgeError(p) {
    const { positions } = makeSurface(p);
    let overshoot = 0,
      undershoot = 0,
      erased = 0;
    p.paint.forEach((color, id) => {
      if (!color) erased++;
      for (let j = 1; j < 9; j += 3) {
        const distance = Math.abs(cy - positions[id * 9 + j] * scale - y);
        if (!color) overshoot = Math.max(overshoot, distance - 18);
        else undershoot = Math.max(undershoot, 18 - distance);
      }
    });
    assert.ok(erased > 0);
    return { overshoot, undershoot };
  }
  const coarse = await drag(),
    before = edgeError(coarse);
  assert.equal(coarse.splits, undefined);
  assert.ok(before.overshoot > 4);
  await page.locator('#undo').click();
  await toggle.check();
  const fine = await drag(),
    after = edgeError(fine);
  assert.ok(fine.splits?.length);
  assert.ok(after.overshoot <= 1 && after.undershoot <= 1, JSON.stringify(after));
  await page.locator('#undo').click();
  await save();
  assert.deepEqual(await readArtwork(), original);
  await page.locator('#redo').click();
  await save();
  assert.deepEqual(await readArtwork(), fine);
  await open();
  assert.deepEqual(await readArtwork(), fine);
  await chooseTool('Brush');
  assert.ok(await toggle.isChecked());
  await toggle.uncheck();
  await save();
  assert.deepEqual(await readArtwork(), fine);
  await toggle.check();
  await page.locator('#projection').click();
  console.log('Thin-strip edge error in px:', { coarse: before, refined: after });
}
