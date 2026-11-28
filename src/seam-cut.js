import triangulate from 'cdt2d';
import { corners, mid, UNIT, vertexKey, world } from './seam-geometry.js';
import { walkPaintCells } from './paint-tree.js';
import { MAX_CELLS, checkFaceLimit } from './mesh.js';

// All calculations use a source triangle's barycentric plane. Input guides
// and paint-tree vertices are integers here; intersections retain another
// sixteen fractional bits. Vertex IDs on shared source edges are topological.
const snap = (n) => Math.round(n * 65536) / 65536;
const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
function position(line, p) {
  return p[line.axis];
}
function lower(points, key, score) {
  let lo = 0,
    hi = points.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (score(points[m]) < key) lo = m + 1;
    else hi = m;
  }
  return lo;
}

class Partition {
  constructor(mesh, face, offset, guides) {
    this.lines = new Map();
    this.points = new Map();
    this.polygons = [];
    this.constraints = [];
    const { cell, node, end } = offset,
      color = mesh.paint[cell];
    this.uniform = !mesh.paint.subarray(cell, end).some((s) => s !== color);
    const polygon = (a, b, c, slot) => {
      const tri = [a, b, c].map((p) => this.point(p));
      this.polygons.push({
        slot,
        ring: tri.map((p, i) => ({ p, line: this.constrain(tri[(i + 2) % 3], p) })),
      });
    };
    if (this.uniform) polygon(...corners, color);
    else
      walkPaintCells(
        mesh,
        (_, f, k) => corners[k],
        mid,
        (a, b, c, id) => polygon(a, b, c, mesh.paint[cell + id]),
        { face, endFace: face + 1, node }
      );
    this.border = corners.map((a, i) => this.line(a, corners[(i + 1) % 3]));
    for (const edge of guides) this.cut(edge[1], edge[2]);
  }
  point(uv) {
    const p = uv.map((n) => (Math.abs(n - Math.round(n)) < 0.00006 ? Math.round(n) : snap(n)));
    if (Math.abs(p[0] + p[1] - UNIT) < 0.00006) p[1] = UNIT - p[0];
    const key = p.join(',');
    if (!this.points.has(key)) this.points.set(key, p);
    return this.points.get(key);
  }
  line(a, b) {
    let dx = b[0] - a[0],
      dy = b[1] - a[1],
      m = Math.abs(dx),
      n = Math.abs(dy);
    while (n) [m, n] = [n, m % n];
    const divisor = dx < 0 || (!dx && dy < 0) ? -m : m;
    dx /= divisor;
    dy /= divisor;
    const k = dx * a[1] - dy * a[0],
      key = [dx, dy, k].join(',');
    if (!this.lines.has(key))
      this.lines.set(key, {
        dx,
        dy,
        k,
        axis: Math.abs(dx) >= Math.abs(dy) ? 0 : 1,
        points: new Set(),
        marked: false,
        owners: new Map(),
      });
    const line = this.lines.get(key);
    line.points.add(this.point(a));
    line.points.add(this.point(b));
    return line;
  }
  constrain(a, b) {
    const line = this.line(a, b);
    this.constraints.push({ a, b, line });
    return line;
  }
  cut(a, b) {
    const cut = this.line(a, b);
    cut.marked = true;
    // The triangulator needs finite, noncrossing constraints. Split both
    // paths at each crossing, including a guide ending on a paint edge.
    for (const { a: p, b: q, line } of this.constraints) {
      if (line === cut) continue; // Collinear constraints already share all knots.
      const dp = orient(a, b, p),
        dq = orient(a, b, q);
      const da = orient(p, q, a),
        db = orient(p, q, b);
      if (dp * dq > 0 || da * db > 0) continue;
      let hit;
      if (dp === 0) hit = p;
      else if (dq === 0) hit = q;
      else if (da === 0) hit = a;
      else if (db === 0) hit = b;
      else {
        const t = da / (da - db);
        hit = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      }
      const point = this.point(hit);
      cut.points.add(point);
      line.points.add(point);
    }
    this.constraints.push({ a, b, line: cut });
  }
  triangulate(depth) {
    const points = [...this.points.values()],
      count = points.length;
    const ids = new Map(points.map((p, i) => [p, i]));
    const key = (a, b) => a * count + b;
    for (const line of this.lines.values())
      line.sorted = [...line.points].sort((a, b) => position(line, a) - position(line, b));
    function along(a, b, line, visit) {
      const t = (p) => position(line, p);
      const start = lower(line.sorted, t(a), t),
        end = lower(line.sorted, t(b), t);
      const step = start < end ? 1 : -1;
      for (let i = start; i !== end; i += step)
        visit(ids.get(line.sorted[i]), ids.get(line.sorted[i + step]));
    }
    const edges = new Map();
    for (const { a, b, line } of this.constraints)
      along(a, b, line, (i, j) => {
        const id = key(Math.min(i, j), Math.max(i, j));
        if (!edges.has(id)) edges.set(id, [i, j]);
      });
    const cells = triangulate(points, [...edges.values()]);
    const owners = new Map(),
      tris = (this.tris = []);
    for (const cell of cells) {
      const uv = cell.map((i) => points[i]);
      const area = orient(...uv) / (UNIT * UNIT);
      if (!(area > 0)) throw Error('The seam is too close to an existing vertex to make a valid cut.');
      const d = this.uniform
        ? Math.max(0, Math.min(depth, Math.round(depth + Math.log(area) / Math.log(4))))
        : 0;
      const tri = { uv, slot: this.uniform ? this.polygons[0].slot : null, depth: d };
      tris.push(tri);
      for (let k = 0; k < 3; k++) owners.set(key(cell[k], cell[(k + 1) % 3]), { tri, k });
    }
    // A constrained edge must exist regardless of which side owns the guide.
    for (const { a, b, line } of this.constraints)
      if (line.marked)
        along(a, b, line, (i, j) => {
          const owner = owners.get(key(i, j)) ?? owners.get(key(j, i));
          if (!owner) throw Error('Could not preserve a continuous seam boundary.');
          const { tri, k } = owner,
            v = tri.uv[k],
            w = tri.uv[(k + 1) % 3];
          line.owners.set(Math.min(position(line, v), position(line, w)), { a: v, b: w, tri, k });
        });
    if (!this.uniform) {
      // Every original paint cell has CCW edges. Seed its new triangles on
      // their inside, then carry its slot to any enclosed interior triangles.
      const queue = [];
      for (const { ring, slot } of this.polygons)
        for (let k = 0; k < 3; k++) {
          const { p, line } = ring[k];
          along(ring[(k + 2) % 3].p, p, line, (i, j) => {
            const tri = owners.get(key(i, j))?.tri;
            if (!tri) throw Error('Could not preserve a painted triangle boundary.');
            if (tri.slot === null) {
              tri.slot = slot;
              queue.push(tri);
            }
          });
        }
      for (const tri of queue)
        for (let k = 0; k < 3; k++) {
          const other = owners.get(key(ids.get(tri.uv[(k + 1) % 3]), ids.get(tri.uv[k])))?.tri;
          if (other?.slot === null) {
            other.slot = tri.slot;
            queue.push(other);
          }
        }
      if (queue.length !== tris.length) throw Error('Could not preserve all paint along the cut.');
    }
    return tris;
  }
  trace(a, b) {
    const line = this.line(a, b),
      t = (p) => position(line, p),
      reverse = t(a) > t(b);
    const first = lower(line.sorted, Math.min(t(a), t(b)), t),
      last = lower(line.sorted, Math.max(t(a), t(b)), t);
    if (first === last) throw Error('Could not preserve a continuous seam boundary.');
    const edges = [];
    for (let i = first; i < last; i++) {
      const e = line.owners.get(t(line.sorted[i]));
      if (!e) throw Error('Could not preserve a continuous seam boundary.');
      const k = e.k,
        j = (k + 1) % 3,
        ordered = t(e.a) < t(e.b);
      edges.push([e.tri.face, corners[ordered ? k : j], corners[ordered ? j : k], e.tri.root]);
    }
    return reverse ? edges.reverse().map(([f, u, v, r]) => [f, v, u, r]) : edges;
  }
  locate(p) {
    for (const tri of this.tris) {
      const [a, b, c] = tri.uv,
        area = orient(a, b, c);
      const u = orient(a, p, c) / area,
        v = orient(a, b, p) / area;
      if (u < -1e-8 || v < -1e-8 || u + v > 1 + 1e-8) continue;
      const x = Math.max(0, Math.min(UNIT, Math.round(u * UNIT)));
      return { face: tri.face, uv: [x, Math.max(0, Math.min(UNIT - x, Math.round(v * UNIT)))] };
    }
    throw Error('Could not reattach a seam node to its cut face.');
  }
}
function faceOffsets(mesh) {
  const n = mesh.depth.length,
    cells = new Uint32Array(n + 1),
    roots = new Uint32Array(n + 1);
  let node = 0;
  for (let f = 0; f < n; f++) {
    const count = 4 ** mesh.depth[f];
    let leaves = count;
    if (mesh.splits)
      for (let pending = count; pending; node++) {
        if (mesh.splits[node]) {
          pending++;
          leaves++;
        } else pending--;
      }
    cells[f + 1] = cells[f] + leaves;
    roots[f + 1] = roots[f] + count;
  }
  return { cells, roots };
}

export function cutSeamMesh(mesh, seams, edited) {
  const { cells, roots } = faceOffsets(mesh),
    count = mesh.depth.length;
  const byFace = new Map(),
    parts = new Map(),
    queue = new Set(seams[edited].edges.map((e) => e[0]));
  for (const seam of seams)
    for (const edge of seam.edges) {
      if (!byFace.has(edge[0])) byFace.set(edge[0], []);
      byFace.get(edge[0]).push(edge);
    }
  const next = new Int32Array(mesh.faces.length),
    head = new Int32Array(mesh.vertices.length / 3).fill(-1);
  for (let i = 0; i < mesh.faces.length; i++) {
    const id = mesh.faces[i];
    next[i] = head[id];
    head[id] = i;
  }
  const borders = new Map();
  function borderInfo(f, k) {
    const a = mesh.faces[3 * f + k],
      b = mesh.faces[3 * f + ((k + 1) % 3)];
    return { a, b, key: Math.min(a, b) * 8388608 + Math.max(a, b) };
  }
  function edgeUV(k, t) {
    return k === 0 ? [t, 0] : k === 1 ? [UNIT - t, t] : [0, UNIT - t];
  }
  for (const f of queue) {
    const part = new Partition(
      mesh,
      f,
      { cell: cells[f], node: 2 * cells[f] - roots[f], end: cells[f + 1] },
      byFace.get(f) ?? []
    );
    parts.set(f, part);
    for (let k = 0; k < 3; k++) {
      const line = part.border[k];
      if (line.points.size <= 2) continue;
      const { a, b, key } = borderInfo(f, k);
      if (!borders.has(key)) {
        borders.set(key, new Set());
        for (let i = head[a]; i >= 0; i = next[i]) {
          const other = Math.floor(i / 3),
            j = i % 3;
          if (mesh.faces[3 * other + ((j + 1) % 3)] === b || mesh.faces[3 * other + ((j + 2) % 3)] === b)
            queue.add(other);
        }
      }
      for (const p of line.points) {
        const t = k === 0 ? p[0] : k === 1 ? p[1] : UNIT - p[1];
        borders.get(key).add(a < b ? t : UNIT - t);
      }
    }
  }
  const firstFace = new Uint32Array(count),
    firstRoot = new Uint32Array(count);
  let numFaces = 0,
    numCells = 0,
    numRoots = 0;
  for (let f = 0; f < count; f++) {
    firstFace[f] = numFaces;
    firstRoot[f] = numRoots;
    const part = parts.get(f);
    if (!part) {
      numFaces++;
      numCells += cells[f + 1] - cells[f];
      numRoots += roots[f + 1] - roots[f];
      continue;
    }
    for (let k = 0; k < 3; k++) {
      const { a, b, key } = borderInfo(f, k);
      for (const t of borders.get(key) ?? [])
        part.border[k].points.add(part.point(edgeUV(k, a < b ? t : UNIT - t)));
    }
    for (const tri of part.triangulate(mesh.depth[f])) {
      tri.face = numFaces++;
      tri.root = numRoots;
      numRoots += 4 ** tri.depth;
      numCells += 4 ** tri.depth;
    }
    checkFaceLimit(numFaces);
    if (numCells > MAX_CELLS) throw Error('This seam would exceed the paint triangle limit.');
  }
  checkFaceLimit(numFaces);
  if (numCells > MAX_CELLS) throw Error('This seam would exceed the paint triangle limit.');
  const faces = new Uint32Array(3 * numFaces),
    depth = new Uint8Array(numFaces),
    paint = new Uint8Array(numCells);
  const splits = numCells > numRoots ? new Uint8Array(2 * numCells - numRoots) : undefined;
  const added = [],
    ids = new Map(),
    oldCount = mesh.vertices.length / 3;
  function index(f, uv) {
    const k = corners.findIndex((p) => same(p, uv));
    if (k >= 0) return mesh.faces[3 * f + k];
    const key = vertexKey(mesh, f, uv);
    if (!ids.has(key)) {
      ids.set(key, oldCount + added.length / 3);
      added.push(...world(mesh, f, uv));
    }
    return ids.get(key);
  }
  let cell = 0,
    node = 0;
  for (let f = 0; f < count; f++) {
    const part = parts.get(f);
    if (!part) {
      faces.set(mesh.faces.subarray(3 * f, 3 * f + 3), 3 * firstFace[f]);
      depth[firstFace[f]] = mesh.depth[f];
      paint.set(mesh.paint.subarray(cells[f], cells[f + 1]), cell);
      const start = 2 * cells[f] - roots[f],
        end = 2 * cells[f + 1] - roots[f + 1];
      if (splits && mesh.splits) splits.set(mesh.splits.subarray(start, end), node);
      cell += cells[f + 1] - cells[f];
      node += end - start;
      continue;
    }
    for (const tri of part.tris) {
      faces.set(
        tri.uv.map((uv) => index(f, uv)),
        3 * tri.face
      );
      depth[tri.face] = tri.depth;
      const n = 4 ** tri.depth;
      paint.fill(tri.slot, cell, cell + n);
      cell += n;
      node += n;
    }
  }
  const vertices = new Float32Array(mesh.vertices.length + added.length);
  vertices.set(mesh.vertices);
  vertices.set(added, mesh.vertices.length);
  for (const part of parts.values())
    for (const { face } of part.tris) {
      const a = faces[3 * face] * 3,
        b = faces[3 * face + 1] * 3,
        c = faces[3 * face + 2] * 3;
      const ab = [0, 1, 2].map((k) => vertices[b + k] - vertices[a + k]),
        ac = [0, 1, 2].map((k) => vertices[c + k] - vertices[a + k]);
      if (ab.every((_, k) => ab[k] * ac[(k + 1) % 3] === ac[k] * ab[(k + 1) % 3]))
        throw Error('This seam is closer to another edge than the mesh coordinate precision allows.');
    }
  const remapped = seams.map((s) => {
    const edges = [],
      ends = [],
      oldEnds = new Set(s.segmentEnds ?? []);
    for (const [i, [f, a, b, r]] of s.edges.entries()) {
      if (parts.has(f)) for (const e of parts.get(f).trace(a, b)) edges.push(e);
      else edges.push([firstFace[f], a, b, firstRoot[f] + r - roots[f]]);
      if (oldEnds.has(i + 1)) ends.push(edges.length);
    }
    const nodes = s.nodes.map((n) =>
      parts.has(n.face) ? parts.get(n.face).locate(n.uv) : { ...n, face: firstFace[n.face] }
    );
    return { ...s, nodes, edges, ...(s.segmentEnds && { segmentEnds: ends }) };
  });
  return { vertices, faces, depth, paint, splits, seams: remapped };
}
