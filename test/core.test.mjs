import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strFromU8 } from 'fflate';
import { readSTL, newProject, makeSurface, flood, bounds } from '../src/mesh.js';
import { writeProject, readProject, paintTree, write3MF } from '../src/files.js';
import { mapImage } from '../src/stamps.js';
import { stampFootprint } from '../src/stamp-footprint.js';
import { fixture } from './fixture.mjs';
import { validSplits, MAX_EDGE_DEPTH } from '../src/paint-tree.js';

test('discarded ASCII facets contribute no vertices, even when rounding collapses an edge', () => {
  const solid = (facets) => new TextEncoder().encode(
    'solid s\n' + facets.map((points) =>
      'facet normal 0 0 1\nouter loop\n' + points.map((p) => 'vertex ' + p).join('\n') +
      '\nendloop\nendfacet\n').join('') + 'endsolid s'
  );
  const good = ['0 0 0', '1 0 0', '0 0.000001 0'];
  const discarded = [
    ['0 0 0', '10000 0 0', '20000 0 0'],
    ['10000 1 0', '10000.00001 1 0', '10000 2 0'],
  ];
  const clean = readSTL(solid([good]), 'sliver.stl');
  assert.deepEqual(readSTL(solid([...discarded, good]), 'sliver.stl'), clean);
  assert.throws(() => readSTL(solid(discarded), 'empty.stl'), /no usable triangles/);
});

test('rotated stamp placement stays inside every edge and centers oversized axes', () => {
  const stamp = { width: 4, height: 2, pixels: new Uint8Array(8).fill(1) };
  const workspace = { width: 100, height: 70 };
  for (const x of [-500, 500]) {
    for (const y of [-500, 500]) {
      const f = stampFootprint(stamp, { x, y, rotation: 33, width: 60, workspace });
      assert.ok(f.xmin >= -1e-8 && f.ymin >= -1e-8);
      assert.ok(f.xmax <= workspace.width + 1e-8 && f.ymax <= workspace.height + 1e-8);
      assert.equal(f.sample(f.center), 1);
    }
  }
  const wide = stampFootprint(stamp, { x: 250, y: -50, rotation: 0, width: 120, workspace });
  assert.deepEqual(wide.center, { x: 50, y: 30 });
  assert.equal(wide.xmax - wide.xmin, 120);
  const huge = stampFootprint(stamp, { x: -150, y: 300, rotation: 45, width: 250, workspace });
  assert.deepEqual(huge.center, { x: 50, y: 35 });
});

test('older projects with stray vertices retain paint, face order and exported geometry', () => {
  const clean = readSTL(fixture(), 'Slab.stl');
  clean.paint[1] = 2;
  const legacy = {
    ...clean,
    vertices: Float32Array.of(-10000, 10, 10, ...clean.vertices.slice(0, 6), 0, 20000, 0, ...clean.vertices.slice(6)),
    faces: clean.faces.map((i) => i < 2 ? i + 1 : i + 2),
  };
  const reopened = readProject(writeProject(legacy));
  assert.deepEqual(reopened, clean);
  const mesh = (p) => unzipSync(write3MF(p))['3D/3dmodel.model'];
  assert.deepEqual(mesh(reopened), mesh(clean));
});

test('stamp refinement detects an interior ink pixel or hole even when every corner and the center agree', () => {
  const placement = { x: 4, y: 4, width: 8, rotation: 0 };
  const corners = [
    { x: 0.1, y: 0.1 },
    { x: 7.9, y: 0.1 },
    { x: 0.1, y: 7.9 },
  ];
  for (const [background, detail] of [
    [255, 2],
    [2, 255],
    [2, 3],
  ]) {
    const pixels = new Uint8Array(64).fill(background);
    pixels[1 * 8 + 3] = detail;
    const footprint = stampFootprint({ width: 8, height: 8, pixels }, placement);
    for (const point of [...corners, { x: 2.7, y: 2.7 }])
      assert.equal(footprint.sample(point), background);
    assert.equal(footprint.classify(corners), -1);
    assert.equal(footprint.sample({ x: 3.5, y: 1.5 }), detail);
  }
});

test('adaptive halves retain winding, use the 3MF paint edge codes, and round-trip with their colors', () => {
  const p = newProject(
    'triangle',
    Float32Array.of(0, 0, 0, 2, 0, 0, 0, 2, 0),
    Uint32Array.of(0, 1, 2)
  );
  p.depth = Uint8Array.of(0);
  p.paint = Uint8Array.of(0, 1);
  for (const side of [1, 2, 3]) {
    p.splits = Uint8Array.of(side, 0, 0);
    const loaded = readProject(writeProject(p));
    assert.deepEqual(loaded, p);
    const s = makeSurface(loaded);
    for (let k = 0; k < 18; k += 9) {
      const a = s.positions;
      const area2 =
        (a[k + 3] - a[k]) * (a[k + 7] - a[k + 1]) - (a[k + 4] - a[k + 1]) * (a[k + 6] - a[k]);
      assert.equal(area2, 2);
    }
    assert.deepEqual(flood(loaded, s, 0, 0, true), [0]);
    assert.deepEqual(flood(loaded, s, 0, 0, false), [0, 1]);
    const model = strFromU8(unzipSync(write3MF(loaded))['3D/3dmodel.model']);
    assert.ok(model.includes('paint_color="48' + (1 + (side - 1) * 4) + '"'));
  }
  const archive = unzipSync(writeProject(p));
  archive['splits.u8'] = Uint8Array.of(0, 1, 0);
  assert.throws(() => readProject(zipSync(archive)), /damaged/);
  const deep = new Uint8Array(2 * MAX_EDGE_DEPTH + 3);
  deep.fill(1, 0, MAX_EDGE_DEPTH + 1);
  assert.equal(validSplits(deep, 1, MAX_EDGE_DEPTH + 2), false);
});

test('binary and ASCII import, dimensions, malformed and empty files', () => {
  const p = readSTL(fixture(), 'Bevel.stl');
  assert.deepEqual(bounds(p.vertices).size, [95, 52, 12]);
  assert.equal(p.depth.length, 28);
  const text = new TextEncoder();
  const stl =
    'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 4 0 0\nvertex 0 3 0\nendloop\nendfacet\nendsolid';
  assert.equal(readSTL(text.encode(stl), 't').depth.length, 1);
  assert.throws(() => readSTL(fixture().subarray(0, 90), 'bad'));
  assert.throws(() => readSTL(text.encode(stl.replace('4 0 0', 'nan 0 0')), 'bad'));
  assert.throws(() => readSTL(text.encode('solid x\nendsolid'), 'empty'));
});
test('fill crosses different subdivision depths, follows successive dihedral angles, stops at a gap or paint', () => {
  const vertices = [];
  let x = 0,
    z = 0;
  for (const angle of [0, 15, 30, 120]) {
    if (!vertices.length) vertices.push(x, 0, z, x, 1, z);
    x += Math.cos((angle * Math.PI) / 180);
    z += Math.sin((angle * Math.PI) / 180);
    vertices.push(x, 0, z, x, 1, z);
  }
  vertices.push(10, 0, 0, 11, 0, 0, 10, 1, 0);
  const faces = [];
  for (let i = 0; i < 4; i++) {
    const a = 2 * i;
    faces.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  faces.push(10, 11, 12);
  const p = newProject('edges', Float32Array.from(vertices), Uint32Array.from(faces));
  p.depth = Uint8Array.from([2, 1, 2, 1, 1, 2, 0, 1, 0]);
  p.paint = new Uint8Array(p.depth.reduce((n, d) => n + 4 ** d, 0));
  const s = makeSurface(p);
  const reached = (degree, protect = true) =>
    [...new Set(flood(p, s, 0, degree, protect).map((id) => s.owners[id]))].sort();
  assert.deepEqual(reached(20), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(reached(10), [0, 1]);
  assert.deepEqual(reached(180), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (let k = 0; k < p.paint.length; k++) if (s.owners[k] === 3) p.paint[k] = 1;
  assert.deepEqual(reached(20), [0, 1, 2]);
  assert.deepEqual(reached(20, false), [0, 1, 2, 3, 4, 5]);
});
test('independent leaf ordering, filament slot compaction, extended colors and project integrity', () => {
  const p = readSTL(fixture(), 'bevel');
  p.depth.fill(0);
  p.depth[0] = 1;
  p.paint = new Uint8Array(p.depth.length + 3);
  p.paint.set([0, 2, 3, 2]);
  p.stamps.push({
    name: 'logo',
    width: 2,
    height: 1,
    source: Uint8Array.of(137, 80),
    pixels: Uint8Array.of(255, 3),
  });
  assert.equal(paintTree(p.paint, 0, 4, [1, 0, 2, 3]), '480C83');
  assert.equal(
    paintTree(
      Uint8Array.of(15),
      0,
      1,
      Array.from({ length: 16 }, (_, i) => i + 1)
    ),
    'DC'
  );
  assert.deepEqual(readProject(writeProject(p)), p);
  const zip = unzipSync(write3MF(p));
  assert.match(strFromU8(zip['3D/3dmodel.model']), /<metadata name="Application">STL Painter<\/metadata>/);
  assert.match(strFromU8(zip['3D/3dmodel.model']), /paint_color="480C83"/);
  assert.deepEqual(JSON.parse(strFromU8(zip['Metadata/project_settings.config'])).filament_colour, [
    p.palette[0],
    p.palette[2],
    p.palette[3],
  ]);
  const corrupt = unzipSync(writeProject(p));
  corrupt['paint.u8'][0] = 22;
  assert.throws(() => readProject(zipSync(corrupt)), /damaged/);
});
test('stamp mapping retains transparent pixels and honors existing palette and new-color budget', () => {
  const rgba = Uint8Array.of(0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 17);
  const palette = ['#F1F1F1', '#0000FF'];
  const limited = mapImage(rgba, palette, 1);
  assert.deepEqual(limited.added, ['#FF0000']);
  assert.deepEqual([...limited.pixels], [255, 2, 1]);
  assert.equal(mapImage(rgba, palette, 0).added.length, 0);
  assert.throws(() => mapImage(new Uint8Array(4), palette, 3), /transparent/);
});

test('opacity cutoff removes the faint fringe before allocating palette slots', () => {
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 4; y < 28; y++) {
    for (let x = 4; x < 28; x++) {
      const solid = x >= 8 && x < 24 && y >= 8 && y < 24;
      data.set(solid ? [0, 0, 255, 255] : [255, 0, 0, 1], (y * 32 + x) * 4);
    }
  }
  const palette = ['#FFFFFF'];
  const original = mapImage(data, palette, 2, 0);
  const filtered = mapImage(data, palette, 2, 50);
  assert.equal(original.pixels.filter((i) => i !== 255).length, 576);
  assert.equal(filtered.pixels.filter((i) => i !== 255).length, 256);
  assert.deepEqual(filtered.added, ['#0000FF']);

  const boundary = Uint8Array.from([0, 1, 127, 128, 254, 255].flatMap((a) => [255, 255, 255, a]));
  assert.deepEqual([...mapImage(boundary, palette, 0, 50).pixels], [255, 255, 255, 0, 0, 0]);
  assert.deepEqual([...mapImage(boundary, palette, 0, 100).pixels], [255, 255, 255, 255, 255, 0]);
});

test('fill can reach each incident facet at a non-manifold shared edge', () => {
  const p = newProject(
    'shared edge',
    Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1),
    Uint32Array.of(0, 1, 2, 1, 0, 3, 0, 1, 4)
  );
  p.depth = Uint8Array.of(0, 0, 0);
  p.paint = new Uint8Array(3);
  const s = makeSurface(p);
  assert.deepEqual(flood(p, s, 0, 180, true).sort(), [0, 1, 2]);
  assert.deepEqual(flood(p, s, 0, 10, true).sort(), [0, 1]);
});
