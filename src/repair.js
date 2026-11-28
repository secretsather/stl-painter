import { MAX_CELLS, readSTL } from './mesh.js';
import { MeshRepairPresets } from 'meshrepair';

// The repair engine takes binary STL. Normals are derived from winding.
export function sourceSTL({ vertices, faces }) {
  const count = faces.length / 3, bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  for (let face = 0; face < count; face++) {
    let offset = 96 + face * 50;
    for (let c = 0; c < 3; c++) {
      const i = faces[3 * face + c] * 3;
      for (let axis = 0; axis < 3; axis++, offset += 4) view.setFloat32(offset, vertices[i + axis], true);
    }
  }
  return bytes;
}

// Match painted faces by exact coordinates, allowing cyclic rotation. Restoring
// the original first corner keeps every uniform and adaptive paint cell aligned.
function faceKey(mesh, face) {
  const points = [];
  for (let c = 0; c < 3; c++) {
    const i = mesh.faces[face * 3 + c] * 3, v = mesh.vertices;
    points.push(v[i] + ',' + v[i + 1] + ',' + v[i + 2]);
  }
  let start = points[1] < points[0] ? 1 : 0;
  if (points[2] < points[start]) start = 2;
  return { start, key: [points[start], points[(start + 1) % 3], points[(start + 2) % 3]].join('|') };
}

function carryPaint(original, next) {
  const locks = original.lockedSlots ?? new Set();
  const seamFaces = new Set();
  for (const s of original.seams ?? []) {
    for (const n of s.nodes) seamFaces.add(n.face);
    for (const edge of s.edges) seamFaces.add(edge[0]);
  }
  if (!seamFaces.size && !locks.has(0) && !original.paint.some(slot => slot !== 0)) return 0;
  const remap = new Map();
  let firstRoot = 0;
  const painted = new Map(), matches = new Map();
  let node = 0, cell = 0, protectedCount = 0;
  for (let f = 0; f < original.depth.length; f++) {
    const roots = 4 ** original.depth[f], first = cell, begin = node;
    if (original.splits) {
      for (let pending = roots; pending; node++) {
        if (original.splits[node]) pending++;
        else { pending--; cell++; }
      }
    } else cell += roots;
    const colors = original.paint.subarray(first, cell);
    const root = firstRoot;
    firstRoot += roots;
    const protectedPaint = locks.has(0) || colors.some(slot => slot !== 0);
    if (!seamFaces.has(f) && !protectedPaint) continue;
    const { start, key } = faceKey(original, f);
    const entry = { start, colors, protectedPaint, face:f, root, depth: original.depth[f], splits: original.splits?.subarray(begin, node),
      previous: painted.get(key) };
    painted.set(key, entry);
    if (protectedPaint) protectedCount++;
  }
  let length = next.paint.length, nodes = length;
  for (let f = 0; f < next.depth.length; f++) {
    const { start, key } = faceKey(next, f), entry = painted.get(key);
    if (!entry) continue;
    const offset = (start - entry.start + 3) % 3, j = f * 3;
    const corners = next.faces.slice(j, j + 3);
    for (let c = 0; c < 3; c++) next.faces[j + c] = corners[(offset + c) % 3];
    const roots = 4 ** next.depth[f];
    length += entry.colors.length - roots;
    nodes += (entry.splits?.length ?? entry.colors.length) - roots;
    next.depth[f] = entry.depth;
    matches.set(f, entry);
    if (entry.protectedPaint) protectedCount--;
    if (entry.previous) painted.set(key, entry.previous);
    else painted.delete(key);
  }
  const missed = protectedCount;
  if (length > MAX_CELLS) throw Error('Keeping the existing paint would exceed the paint triangle limit.');
  next.paint = new Uint8Array(length);
  if (original.splits) next.splits = new Uint8Array(nodes);
  node = cell = firstRoot = 0;
  for (let f = 0; f < next.depth.length; f++) {
    const entry = matches.get(f), roots = 4 ** next.depth[f];
    if (entry) {
      next.paint.set(entry.colors, cell);
      if (entry.splits) next.splits.set(entry.splits, node);
    }
    if (entry && seamFaces.has(entry.face)) remap.set(entry.face, {face:f, offset:firstRoot-entry.root});
    firstRoot += roots;
    cell += entry?.colors.length ?? roots;
    node += entry?.splits?.length ?? roots;
  }
  if (original.seams?.length) {
    next.seams = original.seams.filter(s => s.nodes.every(n => remap.has(n.face)) &&
      s.edges.every(e => remap.has(e[0]))).map(s => ({...s,
      nodes:s.nodes.map(n => ({...n,face:remap.get(n.face).face})),
      edges:s.edges.map(([f,a,b,r]) => [remap.get(f).face,a,b,r+remap.get(f).offset]),
    }));
  }
  return missed;
}

export function checkMesh(engine, original) {
  const bytes = sourceSTL(original);
  const first = evaluateRepair(original, engine.repair('model.stl', bytes, 'print-ready'));
  if (!first.paintAtRisk && !first.lostSeams) return first;
  // Near-vertex welding can move painted corners far from the hole. Retry from
  // the original geometry, welding only vertices with identical coordinates.
  const exact = evaluateRepair(original, engine.repair('model.stl', bytes,
    { ...MeshRepairPresets['print-ready'], weldTolerance: -1 }));
  return exact.mesh && (exact.paintAtRisk < first.paintAtRisk ||
    (exact.paintAtRisk === first.paintAtRisk && exact.lostSeams < first.lostSeams)) ? exact : first;
}

function evaluateRepair(original, { result, output }) {
  const changed = original.vertices.length / 3 !== result.input.vertices ||
    ['duplicateFacesRemoved', 'degenerateFacesRemoved', 'nonManifoldFacesRemoved', 'nonManifoldVerticesRemoved',
      'holesFilled', 'invalidFacesRemoved', 'nonManifoldEdgesSplit', 'tJunctionsFixed', 'facesFlipped',
      'shellsFlipped', 'smallShellsRemoved', 'isolatedFacesRemoved'].some(key => result[key] > 0);
  const sound = result.output.watertight && result.output.manifold && result.output.oriented;
  if (!changed) return sound ? { result } :
    { result, warning: 'The model has mesh issues that the automatic repair could not resolve.' };
  const { vertices, faces, depth, paint } = readSTL(output, 'Repaired');
  const mesh = { vertices, faces, depth, paint, splits: undefined };
  const paintAtRisk = carryPaint(original, mesh);
  const details = [];
  if (result.holesFilled) details.push('The repair can close ' + result.holesFilled + (result.holesFilled === 1 ? ' hole.' : ' holes.'));
  else details.push('The repair can correct problems in the mesh geometry.');
  if (!sound) details.push('Some mesh issues will remain.');
  if (paintAtRisk) details.push('Paint or lock protection cannot be carried over on ' +
    paintAtRisk.toLocaleString() + (paintAtRisk === 1 ? ' source triangle.' : ' source triangles.') +
    ' Replacement surfaces use the base color.');
  const lostSeams = (original.seams?.length ?? 0) - (mesh.seams?.length ?? 0);
  if (lostSeams) details.push('This repair removes ' + lostSeams + ' seam guide(s) attached to replaced faces. Undo restores them.');
  let message = 'Repaired STL geometry.';
  if (result.holesFilled) message += ' Closed ' + result.holesFilled + (result.holesFilled === 1 ? ' hole.' : ' holes.');
  if (!sound) message += ' Some mesh issues remain.';
  return { result, mesh, paintAtRisk, lostSeams, warning: details.join(' '), message };
}
