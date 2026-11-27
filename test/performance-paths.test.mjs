import assert from 'node:assert/strict';
import test from 'node:test';
import { adjacency, makeSurface } from '../src/mesh.js';
import { applyLeafEdits, mergeRepaintedCells, surfaceRanges } from '../src/paint-tree.js';
import { FillIndex } from '../src/fill-index.js';
import { mapImage } from '../src/stamps.js';
import { mixCandidates } from '../src/mixes.js';

test('a commit can collapse nested siblings and grow another tree across chunk boundaries', () => {
  const p = {depth: new Uint8Array(8200), paint: new Uint8Array(8203)};
  p.depth[0] = 1; // Four base paint cells on the first triangle.
  const nested = {side: 2, left: 3, right: {side: 1, left: 4, right: 3}};
  const retained = {side: 3, left: 3, right: 3};
  const first = applyLeafEdits(p, new Map([[0, nested], [1, retained]]));
  const start = {...p, ...first}, last = start.paint.length - 1;
  const edits = new Map([[last, {side: 3, left: 2, right: 1}], [1, 3]]);
  const result = applyLeafEdits(start, edits, start.ranges);
  const expected = applyLeafEdits({...p, paint: p.paint.with(0, 3)}, new Map([[1, retained],
    [p.paint.length - 1, edits.get(last)]]));
  assert.deepEqual(result.paint, expected.paint);
  assert.deepEqual(result.splits, expected.splits);
  assert.deepEqual(result.ranges, surfaceRanges({...p, ...result}));
  assert.deepEqual([...result.changed], [0, 1]);
  assert.equal(start.paint[1], 4);
  // Unrelated uniform siblings survive, and unequal slots never merge.
  assert.equal(mergeRepaintedCells(start, start.ranges, Uint32Array.of(last, 0)), null);
});

test('incremental sections preserve leaf order and neighbors across unequal and non-manifold seams', () => {
  const project = {
    vertices: Float32Array.of(0,0,0, 1,0,0, 0,1,0, 0,-1,0, 0,0,1),
    faces: Uint32Array.of(0,1,2, 1,0,3, 1,0,4), depth: Uint8Array.of(0,1,0),
    paint: Uint8Array.of(0,1,2,0,1,2),
  };
  let ranges = [[0,1], [1,5], [5,6]].map(([cell, endCell], face) =>
    ({ face, endFace: face + 1, cell, endCell, node: cell, endNode: endCell }));
  const index = new FillIndex(project, ranges);
  function compare(p, changed) {
    const graph = index.update(ranges, [...changed].map(i => ({ index: i,
      splits: p.splits?.slice(ranges[i].node, ranges[i].endNode) })));
    const expected = adjacency(p);
    const neighbors = (g, i) => new Set([g.links[i], ...(g.extra.get(i) ?? [])].filter(x => x >= 0));
    for (let h = 0; h < expected.links.length; h++) assert.deepEqual(neighbors(graph, h), neighbors(expected, h));
    const full = makeSurface(p);
    for (const range of ranges) {
      const part = makeSurface(p, range);
      assert.deepEqual(part.positions, full.positions.subarray(range.cell * 9, range.endCell * 9));
      assert.deepEqual(part.owners, full.owners.subarray(range.cell, range.endCell));
    }
  }
  compare(project, [0, 1, 2]);
  let p = project;
  for (const id of [0, 1, 5, 7]) {
    const edit = applyLeafEdits(p, new Map([[id, { side: 3, left: 1, right: 2 }]]), ranges);
    p = { ...p, paint: edit.paint, splits: edit.splits };
    ranges = edit.ranges;
    compare(p, edit.changed);
  }
});

test('reusing an import session preserves independent matching results after control changes', () => {
  const palette = ['#E7DDC8', '#DE7248', '#386D67', '#384956'];
  const candidates = mixCandidates({ palette });
  const data = Uint8ClampedArray.from({length: 2048}, (_, i) => (i * 47) % 256);
  const session = {};
  for (const [limit, opacity, mixed] of [[1,10,true],[4,10,true],[0,80,false],[3,0,true],[2,0,false],[1,0,true]]) {
    const options = { candidates: mixed ? candidates : undefined, capacity: 5 };
    assert.deepEqual(mapImage(data, palette, limit, opacity, { ...options, session }),
      mapImage(data, palette, limit, opacity, options));
  }
});
