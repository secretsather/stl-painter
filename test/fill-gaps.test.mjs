import test from 'node:test';
import assert from 'node:assert/strict';
import { gapGrid } from './fixture.mjs';
import { adjacency, makeSurface } from '../src/mesh.js';
import { findGaps } from '../src/fill-gaps.js';
import { applyLeafEdits } from '../src/paint-tree.js';

function scan(p, threshold, locked = [], seams = false) {
  return findGaps(p.paint, new Set(locked), adjacency(p), makeSurface(p).positions, threshold, seams);
}

test('all unlocked swatches use the exact common border and the largest patch dimension', () => {
  const p = gapGrid(), cell = (x, y) => 2 * (y * 12 + x);
  p.paint.fill(4);
  const base = cell(2, 2), solid = cell(5, 2), stripe = cell(7, 4);
  p.paint[base] = 0;
  p.paint.fill(3, solid, solid + 2);
  p.paint.fill(1, stripe, stripe + 8);
  p.paint[0] = 2; // Open sheet edge.
  const result = scan(p, 0.15, [4]);
  assert.equal(result.count, 2);
  assert.equal(result.targets[base], 4);
  assert.deepEqual([...result.targets.slice(solid, solid + 2)], [4, 4]);
  assert.equal(result.targets[stripe], 255);
  assert.equal(result.targets[0], 255);
  assert.equal(scan(p, 0.14).count, 0);
  assert.equal(scan(p, 0.15, [0, 3]).count, 0);
  p.paint[base + 1] = 2; // Two neighboring specks at a third swatch's boundary.
  assert.equal(scan(p, 0.15).count, 1);
});

test('physical span follows a folded surface and is independent of triangle refinement', () => {
  const p = gapGrid(6, 4, 1);
  // Two adjacent square patches fold 90 degrees about their shared edge.
  for (let i = 0; i < p.vertices.length; i += 3) {
    const x = p.vertices[i];
    if (x > 3) { p.vertices[i] = 3; p.vertices[i + 2] = x - 3; }
  }
  p.paint.fill(1, 16, 20);
  Object.assign(p, applyLeafEdits(p, new Map([[16, { side: 1, left: 1, right: 1 }]])));
  assert.equal(scan(p, 2).count, 0);
  assert.equal(scan(p, Math.sqrt(5)).count, 1);
});

test('a tiny two-color closed shell cannot swap both surrounding colors', () => {
  const p = { vertices: Float32Array.of(0,0,0, 1,0,0, 0,1,0, 0,0,1),
    faces: Uint32Array.of(0,1,2, 0,3,1, 1,3,2, 2,3,0), depth: new Uint8Array(4), paint: Uint8Array.of(1,2,2,2) };
  assert.equal(scan(p, 10).count, 0);
  assert.equal(scan(p, 10, [], true).count, 0);
});

test('a 4 mm seam fills across its 0.2 mm width and stops where the mouth opens out', () => {
  const p = gapGrid(32, 12, 0.2);
  p.paint.fill(4); // An exact saved mix on both sides.
  const cell = (x, y) => (32 * y + x) * 2;
  const seam = cell(2, 5), end = cell(22, 5);
  p.paint.fill(1, seam, end);
  for (let y = 2; y <= 8; y++) p.paint.fill(1, cell(22, y), cell(29, y));
  assert.equal(scan(p, 0.5).count, 0);
  const { count, targets } = scan(p, 0.5, [], true);
  assert.equal(count, 1);
  assert.ok(targets.slice(seam, end).every(slot => slot === 4));
  assert.ok(targets.every((slot, i) => i >= seam && i < end || slot === 255));
  assert.equal(scan(p, 0.15, [], true).count, 0);
  assert.equal(scan(p, 0.5, [1], true).count, 0);
});

test('two pinholes cannot turn the uniform paint between them into a seam', () => {
  const p = gapGrid(14, 9, 0.2), cell = (x, y) => 2 * (14 * y + x);
  for (const spots of [[cell(3, 3), cell(6, 4) + 1],
    [cell(3, 4), cell(3, 4) + 1, cell(9, 4), cell(9, 4) + 1]]) {
    p.paint.fill(0);
    for (const id of spots) p.paint[id] = 1;
    for (const locks of [[], [1]]) {
      const pinholes = scan(p, 5, locks);
      assert.equal(pinholes.count, locks.length ? 0 : 2);
      assert.deepEqual(scan(p, 5, locks, true), pinholes);
    }
  }
});

test('thin seams never leave detached suggestions inside uniform paint', () => {
  const p = gapGrid(14, 9, 0.2), cell = (x, y) => 2 * (14 * y + x);
  // Offset triangular tips on two yellow stripes that run to the open edges.
  p.paint.fill(1, cell(0, 3), cell(3, 3) + 1);
  p.paint.fill(1, cell(6, 4) + 1, cell(14, 4));
  assert.equal(scan(p, 5, [1], true).count, 0);
});

test('a jagged three-color border keeps its edge triangles while a nearby enclosed pinhole fills', () => {
  const cell = (x, y) => 2 * (16 * y + x);
  for (const notch of [1, 2, 4]) {
    const p = gapGrid(16, 12, 0.2);
    p.paint.fill(2, 0, cell(0, 4));
    p.paint.fill(1, cell(0, 4), cell(0, 6));
    // Pink protrudes into the yellow stripe, with red along its other bank.
    const end = cell(9, 5);
    p.paint.fill(0, end - notch, end);
    const pinhole = cell(2, 9);
    p.paint[pinhole] = 1;
    const expected = scan(p, 0.5);
    assert.equal(expected.count, 1);
    assert.equal(expected.targets[pinhole], 0);
    assert.deepEqual(scan(p, 0.5, [], true), expected);
    Object.assign(p, applyLeafEdits(p, new Map([[end - 1, { side: 1, left: 0, right: 0 }]])));
    assert.deepEqual(scan(p, 5, [], true), scan(p, 5));
  }
});

test('a painted seam stops along a tooth-colored bank and at cells bordering an open edge', () => {
  const p = gapGrid(16, 8, 0.2), cell = (x, y) => (16 * y + x) * 2;
  p.paint.fill(4);
  p.paint.fill(1, cell(0, 4), cell(14, 4));
  p.paint.fill(3, cell(6, 3), cell(10, 3));
  const { targets } = scan(p, 0.21, [3,4], true);
  assert.equal(targets[cell(0, 4)], 255);
  assert.equal(targets[cell(4, 4)], 4);
  assert.ok(targets.slice(cell(6, 4), cell(10, 4)).every(slot => slot === 255));
  assert.equal(targets[cell(11, 4)], 4);
});

test('a folded seam uses surface millimeters across refined leaves', () => {
  const p = gapGrid(16, 8, 0.2);
  for (let i = 0; i < p.vertices.length; i += 3) {
    const y = p.vertices[i + 1], crease = Math.fround(0.8);
    if (y > crease) { p.vertices[i + 1] = crease; p.vertices[i + 2] = y - crease; }
  }
  for (const y of [3,4]) p.paint.fill(2, 2*(16*y+2), 2*(16*y+14));
  Object.assign(p, applyLeafEdits(p, new Map([[2*(16*3+7), { side: 1, left: 2, right: 2 }]])));
  const above = scan(p, 0.401, [0], true);
  assert.equal(above.count, 1);
  assert.ok(above.targets.every((slot,i) => slot === (p.paint[i] === 2 ? 0 : 255)));
  assert.equal(scan(p, 0.35, [0], true).count, 0);
});

test('a visually enclosed strip on a disconnected surface stays untouched', () => {
  const p = gapGrid(12, 5);
  const first = 2 * (12 * 2 + 2), end = first + 16;
  p.paint.fill(1, first, end);
  // Give the inset its own vertices, at the same positions as the visible rim.
  const offset = p.vertices.length / 3;
  p.vertices = Float32Array.from([...p.vertices, ...p.vertices]);
  for (let i = first * 3; i < end * 3; i++) p.faces[i] += offset;
  const result = scan(p, 0.5, [], true);
  assert.equal(result.count, 0);
  assert.ok(result.targets.every(slot => slot === 255));
});
