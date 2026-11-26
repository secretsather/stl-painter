import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { newProject, makeSurface } from '../src/mesh.js';
import { readProject, writeProject } from '../src/files.js';

// Measure the committed paint in STL coordinates, independently of the camera.
function paintedSpan(project, axis) {
  const { positions } = makeSurface(project);
  let min = Infinity, max = -Infinity;
  project.paint.forEach((color, id) => {
    if (!color) return;
    for (let corner = 0; corner < 3; corner++) {
      const value = positions[id * 9 + corner * 3 + axis];
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  });
  return max - min;
}

export async function checkPhysicalSizes({ page, app, dir, click, waitIdle, chooseTool, range }) {
  const canvas = page.locator('#viewport > canvas');
  const source = Buffer.from(await page.evaluate(() => {
    const image = document.createElement('canvas');
    image.width = image.height = 1;
    image.getContext('2d').fillRect(0, 0, 1, 1);
    return image.toDataURL().split(',')[1];
  }), 'base64');
  for (const half of [12, 20]) {
    const file = path.join(dir, 'Physical sizes ' + half + '.stlp');
    const vertices = [-half, -half, half, half, -half, half, half, half, half, -half, half, half,
      -half, -half, 0, half, -half, 0, half, half, 0];
    const project = newProject('Plate', Float32Array.from(vertices), Uint32Array.of(0, 1, 2, 0, 2, 3, 4, 5, 6));
    project.stamps.push({ name: 'Square', width: 1, height: 1, pixels: Uint8Array.of(1), source });
    await fs.writeFile(file, writeProject(project));
    await app.evaluate((_, filename) => {
      global.testDialogs.choice = 1;
      global.testDialogs.open = filename;
    }, file);
    await click('open');
    await waitIdle();
    assert.equal(await page.locator('#docname').innerText(), path.basename(file));
    await page.locator('#view').selectOption('Top');
    if ((await page.locator('#projection').innerText() === 'Perspective') !== (half === 12)) await click('projection');
    async function measure(axis, target, name) {
      await click('save');
      await waitIdle();
      const span = paintedSpan(readProject(new Uint8Array(await fs.readFile(file))), axis);
      assert.ok(Math.abs(span - target) < 0.45, name + ' measures ' + span + ' mm, expected ' + target);
      await click('undo');
      return span.toFixed(2);
    }
    for (const zoom of [false, true]) {
      await chooseTool('Brush');
      const box = await canvas.boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.locator('#brush-unit').selectOption('mm');
      await page.locator('#brush-mm').fill('2');
      await page.mouse.move(x, y);
      if (zoom) {
        const before = await page.locator('#pointer').evaluate(el => parseFloat(el.style.width));
        await page.mouse.wheel(0, -320);
        await page.waitForFunction(prev => parseFloat(document.querySelector('#pointer').style.width) > prev, before);
      }
      await page.mouse.move(x - 20, y);
      await page.mouse.down();
      await page.mouse.move(x + 20, y, { steps: 5 });
      await page.mouse.up();
      const brush = await measure(1, 2, 'Brush');
      await chooseTool('Stamps');
      await page.locator('.stamp-choice').click();
      await page.locator('#stamp-unit').selectOption('mm');
      await page.locator('#stamp-mm').fill('8');
      await range('rotation', 0);
      await canvas.click();
      await click('apply');
      const stamp = await measure(0, 8, 'Stamp');
      await chooseTool('Text');
      await page.locator('#text-font').selectOption('Arial');
      await page.locator('#text-bold').uncheck();
      await page.locator('#text-italic').uncheck();
      await page.locator('#text-content').fill('H');
      await page.locator('#text-unit').selectOption('mm');
      await page.locator('#text-mm').fill('6.5');
      const inkHeight = await page.evaluate(() => {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = '96px Arial';
        const glyph = ctx.measureText('H');
        return (glyph.actualBoundingBoxAscent + glyph.actualBoundingBoxDescent) * 6.5 / 96;
      });
      await canvas.click();
      await click('apply');
      const text = await measure(1, inkHeight, 'Text');
      console.log('Physical paint on %d mm plate (zoomed=%s): brush %s, stamp %s, H height %s mm',
        half * 2, zoom, brush, stamp, text);
    }
    await page.locator('#text-unit').selectOption('px');
    await click('open');
    await waitIdle();
    assert.equal(await page.locator('#text-unit').inputValue(), 'mm');
    assert.equal(await page.locator('#text-mm').inputValue(), '6.5');
  }
}
