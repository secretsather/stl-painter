import { Box3, Plane, Vector3, Vector4, Matrix4 } from 'three';
import { UNIT, world } from './seam-geometry.js';

// Earlier files stored an ordered edge walk without segment boundaries.
// Recover those boundaries once for editing, keeping the original edge walk.
export function editableSegments(mesh, seam) {
  let ends = seam.segmentEnds;
  if (!ends) {
    ends = [];
    const count = seam.closed ? seam.nodes.length : seam.nodes.length - 1;
    for (let i = 1; i < count; i++) {
      const n = seam.nodes[i],
        at = world(mesh, n.face, n.uv);
      let best = ends.at(-1) ?? 0,
        distance = Infinity;
      for (let k = best; k < seam.edges.length - (count - i); k++) {
        const [f, , uv] = seam.edges[k];
        const d = world(mesh, f, uv).reduce((sum, v, axis) => sum + (v - at[axis]) ** 2, 0);
        if (d < distance) {
          distance = d;
          best = k + 1;
        }
      }
      ends.push(best);
    }
    ends.push(seam.edges.length);
  }
  const segments = ends
    .map((end, i) => seam.edges.slice(i ? ends[i - 1] : 0, end))
    .filter((s) => s.length);
  const nodes = segments.map((s) => ({ face: s[0][0], uv: s[0][1] }));
  if (!seam.closed) {
    const last = seam.edges.at(-1);
    nodes.push({ face: last[0], uv: last[2] });
  }
  return { segments, nodes };
}

const EPS = 1e-10;
const invalid = () =>
  Error(
    'Keep the previous node and the whole segment visible on one connected surface. Orbit or add a closer node.'
  );
const cornerWeights = [
  [0, 0],
  [1, 0],
  [0, 1],
];
const mix = (a, b, t) => a + (b - a) * t;
function joinEndpoint(mesh, node, face, candidate) {
  let uv = node.uv;
  if (face !== node.face) {
    // Copy weights by shared vertex ID. Two faces can round the very same
    // half-step in opposite directions when their edge winding is reversed.
    const weights = [UNIT - uv[0] - uv[1], ...uv],
      mapped = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      if (!weights[k]) continue;
      const vertex = mesh.faces[3 * node.face + k];
      let j = 0;
      while (j < 3 && mesh.faces[3 * face + j] !== vertex) j++;
      if (j === 3) throw invalid();
      mapped[j] = weights[k];
    }
    uv = mapped.slice(1);
  }
  if (Math.abs(uv[0] - candidate[0]) > 1 || Math.abs(uv[1] - candidate[1]) > 1) throw invalid();
  return uv;
}
function uvAt(a, b, t) {
  // Interpolating on an original triangle edge must give identical barycentric
  // fractions on both incident faces, including the edge opposite corner zero.
  const x = Math.max(0, Math.min(UNIT, Math.round(UNIT * mix(a[0], b[0], t))));
  const y = Math.max(0, Math.min(UNIT - x, Math.round(UNIT * mix(a[1], b[1], t))));
  return [x, Math.abs(mix(a[0] + a[1], b[0] + b[1], t) - 1) < 1e-12 ? UNIT - x : y];
}

// A screen line extrudes to one plane for either camera projection. Intersect
// that plane with source triangles, then take the nearest continuous surface
// over each interval of the line. Even subpixel foreground slivers contribute.
export function projectSegment(mesh, tree, camera, from, to) {
  camera.updateMatrixWorld();
  const matrix = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const clip = (xyz) => new Vector4(...xyz, 1).applyMatrix4(matrix);
  const ends = [from, to].map((n) => clip(world(mesh, n.face, n.uv)));
  if (
    ends.some(
      (p) =>
        p.w <= 0 ||
        Math.abs(p.z) > p.w ||
        Math.abs(p.x) > p.w * 1.000001 ||
        Math.abs(p.y) > p.w * 1.000001
    )
  )
    throw invalid();
  const [a, b] = ends.map((p) => ({ x: p.x / p.w, y: p.y / p.w }));
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length2 = dx * dx + dy * dy;
  if (length2 < 1e-16) throw invalid();
  // Transform clip-space plane equations into model space for BVH pruning.
  const transpose = matrix.clone().transpose();
  function plane(x, y, w) {
    const v = new Vector4(x, y, 0, w).applyMatrix4(transpose);
    return new Plane(new Vector3(v.x, v.y, v.z), v.w).normalize();
  }
  const slice = plane(-dy, dx, dy * a.x - dx * a.y);
  const bounds = [plane(dx, dy, -dx * a.x - dy * a.y), plane(-dx, -dy, dx * b.x + dy * b.y)];
  const spanTolerance = Math.max(
    1e-13,
    tree.getBoundingBox(new Box3()).getSize(new Vector3()).length() * 1e-12
  );
  const spans = [];
  tree.shapecast({
    intersectsBounds: (box) => {
      const center = box.getCenter(new Vector3()),
        half = box.getSize(new Vector3()).multiplyScalar(0.5);
      const radius = (p) =>
        Math.abs(p.normal.x) * half.x +
        Math.abs(p.normal.y) * half.y +
        Math.abs(p.normal.z) * half.z +
        spanTolerance;
      return (
        Math.abs(slice.distanceToPoint(center)) <= radius(slice) &&
        bounds.every((p) => p.distanceToPoint(center) >= -radius(p))
      );
    },
    intersectsTriangle(tri, face) {
      const vertices = [tri.a, tri.b, tri.c],
        dist = vertices.map((v) => slice.distanceToPoint(v));
      const hits = [];
      for (let k = 0; k < 3; k++) {
        const j = (k + 1) % 3,
          p = vertices[k],
          q = vertices[j];
        if (Math.abs(dist[k]) <= spanTolerance) hits.push({ p: p.clone(), uv: cornerWeights[k] });
        if (
          (dist[k] < -spanTolerance && dist[j] > spanTolerance) ||
          (dist[k] > spanTolerance && dist[j] < -spanTolerance)
        ) {
          const t = dist[k] / (dist[k] - dist[j]);
          hits.push({
            p: p.clone().lerp(q, t),
            uv: cornerWeights[k].map((v, i) => mix(v, cornerWeights[j][i], t)),
          });
        }
      }
      if (hits.length !== 2) return false;
      let [h, k] = hits;
      // Clip to near/far before dividing by w, including faces crossing the camera.
      const depths = hits.map((h) => -h.p.clone().applyMatrix4(camera.matrixWorldInverse).z);
      let lo = 0,
        hi = 1;
      if (depths[0] === depths[1]) {
        if (depths[0] < camera.near || depths[0] > camera.far) return false;
      } else {
        const t0 = (camera.near - depths[0]) / (depths[1] - depths[0]),
          t1 = (camera.far - depths[0]) / (depths[1] - depths[0]);
        lo = Math.max(lo, Math.min(t0, t1));
        hi = Math.min(hi, Math.max(t0, t1));
      }
      if (hi <= lo) return false;
      const project = (t) => {
        const p = h.p.clone().lerp(k.p, t),
          c = clip(p.toArray());
        return {
          t: ((c.x / c.w - a.x) * dx + (c.y / c.w - a.y) * dy) / length2,
          z: c.z / c.w,
          w: c.w,
          uv: h.uv.map((u, i) => mix(u, k.uv[i], t)),
        };
      };
      let s = project(lo),
        e = project(hi);
      if (s.t > e.t) [s, e] = [e, s];
      const start = Math.max(0, s.t),
        end = Math.min(1, e.t);
      if (end - start > EPS) spans.push({ face, s, e, start, end });
      return false;
    },
  });
  function bary(span, t) {
    const { s, e } = span,
      u = Math.max(0, Math.min(1, (t - s.t) / (e.t - s.t)));
    return uvAt(s.uv, e.uv, (u * s.w) / ((1 - u) * e.w + u * s.w));
  }
  const depth = (v, t) => mix(v.s.z, v.e.z, (t - v.s.t) / (v.e.t - v.s.t));
  const events = spans
    .flatMap((v) => [
      { t: v.start, add: true, v },
      { t: v.end, add: false, v },
    ])
    .sort((a, b) => a.t - b.t);
  const active = new Set(),
    runs = [];
  let previous = 0;
  function interval(l, r) {
    if (r - l <= EPS) return;
    if (!active.size) throw invalid();
    const items = [...active],
      cuts = [l, r];
    // Intersecting mesh sheets may change front-to-back order inside an interval.
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const left = depth(items[i], l) - depth(items[j], l),
          right = depth(items[i], r) - depth(items[j], r);
        if (left * right < 0 && Math.abs(left - right) > 1e-12)
          cuts.push(mix(l, r, left / (left - right)));
      }
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i] - cuts[i - 1] <= EPS) continue;
      const t = (cuts[i] + cuts[i - 1]) / 2;
      const front = items.reduce((best, v) => (depth(v, t) < depth(best, t) ? v : best));
      const last = runs.at(-1);
      if (last?.v === front) last.end = cuts[i];
      else runs.push({ v: front, start: cuts[i - 1], end: cuts[i] });
    }
  }
  for (const event of events) {
    interval(previous, event.t);
    if (event.add) active.add(event.v);
    else active.delete(event.v);
    previous = event.t;
  }
  interval(previous, 1);
  const edges = [];
  let last = from;
  for (const { v, start, end } of runs) {
    const u = joinEndpoint(mesh, last, v.face, bary(v, start)),
      w = bary(v, end);
    if (u[0] === w[0] && u[1] === w[1]) continue;
    edges.push([v.face, u, w, 0]);
    last = { face: v.face, uv: w };
  }
  if (!edges.length) throw invalid();
  edges.at(-1)[2] = joinEndpoint(mesh, to, last.face, last.uv);
  const [, start, end] = edges.at(-1);
  if (start[0] === end[0] && start[1] === end[1]) edges.pop();
  if (!edges.length) throw invalid();
  return edges;
}
