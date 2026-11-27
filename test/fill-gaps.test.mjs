import test from 'node:test';
import assert from 'node:assert/strict';
import { gapGrid, gapWedge } from './fixture.mjs';
import { adjacency, makeSurface } from '../src/mesh.js';
import { findGaps } from '../src/fill-gaps.js';
import { applyLeafEdits } from '../src/paint-tree.js';

function scan(p, threshold, locked = [], seams = false) {
  return findGaps(p.paint, new Set(locked), adjacency(p), makeSurface(p).positions, threshold, seams);
}

test('an 11.5 mm wedge uses its full surface span even after folding and local subdivision', () => {
  const p = gapWedge();
  const first = p.paint.indexOf(1);
  Object.assign(p, applyLeafEdits(p, new Map([[first, {side: 1, left: 1, right: 1}]])));
  // Fold at an existing grid line without stretching the patch.
  const crease = Math.fround(4.6);
  for (let i = 0; i < p.vertices.length; i += 3) {
    if (p.vertices[i + 1] > crease) {
      p.vertices[i + 2] = p.vertices[i + 1] - crease;
      p.vertices[i + 1] = crease;
    }
  }
  assert.equal(scan(p, 11.49).count, 0);
  const expected = p.paint.map(slot => slot === 1 ? 0 : 255);
  for (const seams of [false, true]) {
    assert.deepEqual(scan(p, 11.5, [0], seams), {count: 1, targets: expected});
    assert.ok(scan(p, 11.5, [1], seams).targets.every(slot => slot === 255));
  }
});

test('a disconnected wedge is skipped while a separate enclosed fleck still counts', () => {
  const p = gapWedge();
  const offset = p.vertices.length / 3;
  p.vertices = Float32Array.from([...p.vertices, ...p.vertices]);
  p.paint.forEach((slot, face) => {
    if (slot === 1) for (let i = 3 * face; i < 3 * face + 3; i++) p.faces[i] += offset;
  });
  const fleck = 2 * (12 * 9 + 9);
  p.paint[fleck] = 2;
  const targets = new Uint8Array(p.paint.length).fill(255);
  targets[fleck] = 0;
  for (const seams of [false, true]) assert.deepEqual(scan(p, 11.5, [], seams), {count: 1, targets});
});

test('a narrow third-color seam between two swatches goes to the nearest bank in surface mm', () => {
  const p = gapGrid(24, 14, 0.2);
  const start = 2*(6*24+4), end = 2*(6*24+20);
  p.paint.fill(4, 2*24*7);
  p.paint.fill(2, start, end);
  const expected = new Uint8Array(p.paint.length).fill(255);
  for (let id = start; id < end; id++) expected[id] = id % 2 ? 4 : 0;
  assert.equal(scan(p, 0.21).count, 0);
  assert.equal(scan(p, 0.19, [], true).count, 0);
  assert.equal(scan(p, 0.21, [2], true).count, 0);
  assert.deepEqual(scan(p, 0.21, [], true), {count:1, targets:expected});
  // Fold down the upper bank and refine a seam triangle. Keep exact mix IDs.
  for (let i = 0; i < p.vertices.length; i += 3) {
    const crease = Math.fround(1.4), y = p.vertices[i+1];
    if (y > crease) { p.vertices[i+1] = crease; p.vertices[i+2] = y-crease; }
  }
  Object.assign(p, applyLeafEdits(p, new Map([[start+12, {side:2, left:2, right:2}]])));
  const result = scan(p, 0.21, [0,4], true);
  const {positions} = makeSurface(p);
  assert.equal(result.count, 1);
  p.paint.forEach((slot, id) => {
    const i = 9*id, y = (positions[i+1]+positions[i+4]+positions[i+7])/3;
    if (slot === 2 && Math.abs(y-1.3) < 1e-6) assert.ok([0,4].includes(result.targets[id]));
    else assert.equal(result.targets[id], slot === 2 ? (y < 1.3 ? 0 : 4) : 255);
  });
});

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

test('broken two-color seams include isolated slivers and tapered ends', () => {
  const p = gapGrid(32, 12, 0.125);
  for (let i = 0; i < p.vertices.length; i += 3) p.vertices[i] *= 8;
  const face = x => 2 * (6 * 32 + x) + 1;
  p.paint.fill(1, 2 * 7 * 32);
  p.paint[face(3)] = 2;
  p.paint.fill(2, face(9), face(9) + 8);
  const targets = new Uint8Array(p.paint.length).fill(255);
  targets[face(3)] = 0;
  targets.set([0, 0, 1, 0, 1, 0, 1, 0], face(9));
  assert.deepEqual(scan(p, 0.15, [], true), {count: 2, targets});
  assert.equal(scan(p, 0.10, [], true).count, 0);
  assert.equal(scan(p, 11.5, [2], true).count, 0);
  assert.equal(scan(p, 11.5).count, 0);
});

test('a narrow seam with a sawtooth bank is measured across its full length', () => {
  const width = 32, p = gapGrid(width, 14, 1);
  const first = 2*(6*width+4), end = 2*(6*width+28);
  p.paint.fill(1, 2*7*width);
  p.paint.fill(2, first, end);
  for (let y = 0; y <= 14; y++) for (let x = 0; x <= width; x++) {
    const k = 3*(y*(width+1)+x);
    p.vertices[k] = x*0.2;
    p.vertices[k+1] = y < 7 ? (y-6)*0.4 : (y-7)*0.4 + (x%2 ? 0.04 : 0.35);
  }
  const result = scan(p, 0.351, [], true);
  assert.equal(result.count, 1);
  for (let id = 0; id < p.paint.length; id++) {
    if (id >= first && id < end) assert.ok([0,1].includes(result.targets[id]), 'missed seam face ' + id);
    else assert.equal(result.targets[id], 255);
  }
  assert.ok(result.targets.includes(0) && result.targets.includes(1));
  assert.equal(scan(p, 0.03, [], true).count, 0);
  assert.equal(scan(p, 0.351, [2], true).count, 0);
  assert.equal(scan(p, 0.351).count, 0);
});

test('a broad lone triangle touching two swatches stays painted', () => {
  const p = gapGrid(12, 12, 1);
  p.paint.fill(1, 2 * 7 * 12);
  p.paint[2 * (6 * 12 + 5) + 1] = 2;
  assert.equal(scan(p, 11.5, [], true).count, 0);
});

test('a short patch between different swatches is not a thin seam', () => {
  const p = gapGrid(24, 14, 0.2);
  p.paint.fill(1, 2*24*7);
  p.paint.fill(2, 2*(6*24+4), 2*(6*24+6));
  assert.equal(scan(p, 2, [], true).count, 0);
});

test('a tapered two-color seam stops where it exceeds the width limit', () => {
  const width = 32, p = gapGrid(width, 14, 0.2);
  const cell = x => 2*(6*width+x);
  p.paint.fill(1, 2*7*width);
  p.paint.fill(2, cell(2), cell(30));
  for (let x = 0; x <= width; x++) {
    const thickness = 0.08 + 0.24*x/width;
    p.vertices[3*(7*(width+1)+x)+1] = 1.2 + thickness;
  }
  const result = scan(p, 0.2, [], true);
  assert.equal(result.count, 1);
  for (let x = 4; x < 13; x++) {
    assert.equal(result.targets[cell(x)], 0);
    assert.equal(result.targets[cell(x)+1], 1);
  }
  assert.ok(result.targets.slice(cell(19), cell(30)).every(slot => slot === 255));
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
