import { walkPaintCells } from './paint-tree.js';

// Integer barycentric coordinates remain exact through eight uniform levels and
// sixteen adaptive bisections. A seam edge therefore survives further splitting.
export const UNIT = 2 ** 24;
export const corners = [
  [0, 0],
  [UNIT, 0],
  [0, UNIT],
];
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

export function world(mesh, face, uv) {
  const a = mesh.faces[face * 3] * 3,
    b = mesh.faces[face * 3 + 1] * 3,
    c = mesh.faces[face * 3 + 2] * 3;
  const u = uv[0] / UNIT,
    v = uv[1] / UNIT,
    xyz = mesh.vertices;
  return [0, 1, 2].map(
    (k) => xyz[a + k] + (xyz[b + k] - xyz[a + k]) * u + (xyz[c + k] - xyz[a + k]) * v
  );
}

function sourceSide(a, b) {
  if (!a[1] && !b[1]) return [0, 1, a[0], b[0]];
  if (!a[0] && !b[0]) return [0, 2, a[1], b[1]];
  if (a[0] + a[1] === UNIT && b[0] + b[1] === UNIT) return [1, 2, a[1], b[1]];
}

export function vertexKey(mesh, f, uv) {
  const slot = corners.findIndex((p) => p[0] === uv[0] && p[1] === uv[1]);
  if (slot >= 0) return 'v' + mesh.faces[3 * f + slot];
  const side = sourceSide(uv, uv);
  if (!side) return f + ':' + uv;
  const [i, j, t] = side,
    a = mesh.faces[3 * f + i],
    b = mesh.faces[3 * f + j];
  return 'e' + Math.min(a, b) + ',' + Math.max(a, b) + ':' + (a < b ? t : UNIT - t);
}

function line(mesh, f, a, b) {
  const side = sourceSide(a, b);
  if (side) {
    const [i, j, t, s] = side,
      u = mesh.faces[3 * f + i],
      v = mesh.faces[3 * f + j];
    return ['e' + Math.min(u, v) + ',' + Math.max(u, v), u < v ? t : UNIT - t, u < v ? s : UNIT - s];
  }
  let dx = b[0] - a[0],
    dy = b[1] - a[1];
  let m = Math.abs(dx),
    n = Math.abs(dy);
  while (n) [m, n] = [n, m % n];
  const divisor = dx < 0 || (!dx && dy < 0) ? -m : m;
  dx /= divisor;
  dy /= divisor;
  const axis = dx ? 0 : 1;
  return [f + ':' + dx + ',' + dy + ',' + (dx * a[1] - dy * a[0]), a[axis], b[axis]];
}

export function validSeams(seams, faces, roots) {
  const uv = (p) =>
    Array.isArray(p) &&
    p.length === 2 &&
    p.every(Number.isInteger) &&
    p[0] >= 0 &&
    p[1] >= 0 &&
    p[0] + p[1] <= UNIT;
  const face = (f) => Number.isInteger(f) && f >= 0 && f < faces;
  return (
    Array.isArray(seams) &&
    seams.every(
      (s) =>
        s &&
        typeof s.closed === 'boolean' &&
        (s.name === undefined || typeof s.name === 'string') &&
        (s.tolerance === undefined || (Number.isFinite(s.tolerance) && s.tolerance > 0)) &&
        Array.isArray(s.nodes) &&
        s.nodes.length >= (s.closed ? 3 : 2) &&
        s.nodes.every((n) => n && face(n.face) && uv(n.uv)) &&
        Array.isArray(s.edges) &&
        s.edges.length &&
        (s.segmentEnds === undefined || (Array.isArray(s.segmentEnds) &&
          s.segmentEnds.length === s.nodes.length - (s.closed ? 0 : 1) &&
          s.segmentEnds.at(-1) === s.edges.length &&
          s.segmentEnds.every((end,i)=> Number.isInteger(end) && end > (i ? s.segmentEnds[i-1] : 0)))) &&
        s.edges.every(
          (e) =>
            Array.isArray(e) &&
            e.length === 4 &&
            face(e[0]) &&
            uv(e[1]) &&
            uv(e[2]) &&
            (e[1][0] !== e[2][0] || e[1][1] !== e[2][1]) &&
            Number.isInteger(e[3]) &&
            e[3] >= 0 &&
            e[3] < roots
        )
    )
  );
}

// Mark fully covered half-edges. On a T-junction the smaller half-edge owns
// the crossing, so both directions of the same neighbor pair are blocked.
export function seamPairs(mesh, seams, ranges, sections, graph) {
  const lines = new Map(),
    touched = new Set(),
    borderVertices = new Set();
  for (const seam of seams)
    for (const [f, a, b] of seam.edges) {
      touched.add(f);
      const [key, t, s] = line(mesh, f, a, b);
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push([Math.min(t, s), Math.max(t, s)]);
      const side = sourceSide(a, b);
      if (side) borderVertices.add(mesh.faces[3 * f + side[0]]);
      if (side) borderVertices.add(mesh.faces[3 * f + side[1]]);
    }
  for (const [key, spans] of lines) {
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push(span);
    }
    lines.set(key, merged);
  }
  const blocked = new Set();
  for (const [i, r] of ranges.entries()) {
    let relevant = false;
    const wanted = (f) =>
      touched.has(f) ||
      (borderVertices.size &&
        [0, 1, 2].filter((k) => borderVertices.has(mesh.faces[3 * f + k])).length >= 2);
    for (let f = r.face; f < r.endFace && !relevant; f++) relevant = wanted(f);
    if (!relevant) continue;
    walkPaintCells(
      { ...mesh, splits: sections[i] },
      (_, f, k) => corners[k],
      mid,
      (a, b, c, id, f) => {
        if (!wanted(f)) return;
        const tri = [a, b, c],
          cell = r.cell + id;
        for (let k = 0; k < 3; k++) {
          const [key, t, s] = line(mesh, f, tri[k], tri[(k + 1) % 3]);
          if (!lines.get(key)?.some(([lo, hi]) => lo <= Math.min(t, s) && hi >= Math.max(t, s)))
            continue;
          const h = 3 * cell + k;
          const block = (other) => {
            if (other >= 0) blocked.add(pairKey(cell, other));
          };
          block(graph.links[h]);
          graph.extra.get(h)?.forEach(block);
        }
      },
      { ...r, node: 0 }
    );
  }
  return blocked;
}
export const pairKey = (a, b) => Math.min(a, b) * 2097152 + Math.max(a, b);
