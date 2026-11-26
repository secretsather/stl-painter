import test from 'node:test';
import assert from 'node:assert/strict';
import { FillPreview } from '../src/fill-preview.js';

test('rapid hovering uses the latest seed and discards stale or invalidated worker results', async () => {
  const searches = [], drawn = [];
  const preview = new FillPreview(seed => new Promise(resolve => searches.push({ seed, resolve })),
    mask => drawn.push(mask));
  const first = Uint8Array.of(1, 1, 0, 0), second = Uint8Array.of(0, 0, 1, 1);
  preview.hover(0);
  preview.hover(1);
  preview.hover(3);
  assert.equal(searches.length, 1);
  searches[0].resolve(first);
  await Promise.resolve();
  assert.deepEqual(drawn, []);
  assert.equal(searches[1].seed, 3);
  preview.hover(2);
  searches[1].resolve(second);
  await Promise.resolve();
  assert.deepEqual(drawn, [second]);
  preview.hover(3);
  assert.equal(searches.length, 2);
  preview.hover(0);
  preview.clear();
  preview.hover(0);
  searches[2].resolve(first);
  await Promise.resolve();
  assert.deepEqual(drawn, [second, null]);
  assert.equal(searches.length, 4);
  preview.clear();
  searches[3].resolve(first);
  await Promise.resolve();
  assert.deepEqual(drawn, [second, null]);
});
