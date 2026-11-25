import assert from 'node:assert/strict';
import { bounds, makeSurface } from '../src/mesh.js';

// Adjacent ink colors plus a narrow line separated by a transparent gap.
// All three bars cross the flutes at an oblique angle.
export async function checkStampEdges({ page, chooseTool, range, click, save }) {
  await page.locator('#view').selectOption('Front');
  await chooseTool('Stamps');
  const rects = [
    [5, 14, 91, 18, 2],
    [5, 18, 91, 22, 3],
    [5, 25, 91, 27, 2],
  ];
  const png = await page.evaluate((rects) => {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 40;
    const ctx = canvas.getContext('2d');
    for (const [x, y, right, bottom, color] of rects) {
      ctx.fillStyle = color === 2 ? '#386D67' : '#384956';
      ctx.fillRect(x, y, right - x, bottom - y);
    }
    return canvas.toDataURL().split(',')[1];
  }, rects);
  await page.locator('#image-input').setInputFiles({
    name: 'Two-color lines.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
  await click('confirm-import');
  const toggle = page.getByRole('checkbox', { name: 'Refine stamp edges' });
  assert.ok(await toggle.isChecked());
  await toggle.uncheck();
  await range('rotation', 29);
  await range('stamp-size', 144);
  const initial = await save();
  const box = await page.locator('#viewport > canvas').boundingBox();
  const b = bounds(initial.vertices);
  const scale =
    box.height /
    (2 * b.diagonal * 1.75 * Math.max(1, box.height / box.width) * Math.tan((35 * Math.PI) / 360));
  const cos = Math.cos((29 * Math.PI) / 180),
    sin = Math.sin((29 * Math.PI) / 180);
  const toUV = (x, z) => {
    const dx = (x - b.min[0] - b.size[0] / 2) * scale;
    const dy = (b.min[2] + b.size[2] / 2 - z) * scale;
    return [(dx * cos + dy * sin) / 1.5 + 48, (dy * cos - dx * sin) / 1.5 + 20];
  };
  function measure(project) {
    const { positions, normals, owners } = makeSurface(project);
    let excess = 0,
      misses = 0,
      interior = 0;
    project.paint.forEach((color, id) => {
      const k = id * 9;
      if (positions[k + 1] > 0 || normals[owners[id] * 3 + 1] >= 0) {
        assert.ok(color < 2, 'hidden wall received stamp ink');
        return;
      }
      if (color >= 2) {
        for (let j = k; j < k + 9; j += 3) {
          const [u, v] = toUV(positions[j], positions[j + 2]);
          const distance = Math.min(
            ...rects
              .filter((r) => r[4] === color)
              .map(([l, t, r, b]) =>
                Math.hypot(Math.max(l - u, u - r, 0), Math.max(t - v, v - b, 0))
              )
          );
          excess = Math.max(excess, distance * 1.5);
        }
      }
      const [u, v] = toUV(
        (positions[k] + positions[k + 3] + positions[k + 6]) / 3,
        (positions[k + 2] + positions[k + 5] + positions[k + 8]) / 3
      );
      for (const [l, t, r, b, ink] of rects) {
        if (Math.min(u - l, v - t, r - u, b - v) * 1.5 <= 1) continue;
        interior++;
        if (color !== ink) misses++;
      }
    });
    assert.ok(interior > 20);
    return { excess, misses };
  }
  await click('apply');
  const coarse = await save();
  assert.equal(coarse.paint.length, initial.paint.length);
  await click('undo');
  await toggle.check();
  await page.locator('#apply:enabled').waitFor();
  assert.deepEqual((await save()).paint, initial.paint, 'preview is transient');
  const clip = {
    x: box.x + box.width / 2 - 90,
    y: box.y + box.height / 2 - 65,
    width: 180,
    height: 130,
  };
  const preview = await page.screenshot({ clip, style: '#stamp-outline { visibility: hidden }' });
  await click('apply');
  const fine = await save();
  assert.ok(
    (await page.screenshot({ clip })).equals(preview),
    'curved preview matches applied paint'
  );
  const before = measure(coarse),
    after = measure(fine);
  assert.ok(before.excess > after.excess && after.excess <= 1, JSON.stringify({ before, after }));
  assert.equal(after.misses, 0);
  console.log('Curved stamp edge overshoot (px) and missed interior cells:', {
    coarse: before,
    refined: after,
  });
}
