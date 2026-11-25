import { walkPaintCells } from './paint-tree.js';
// The leaf order is part of the project format and matches the four-child split in the painted 3MF.
export const LARGE_MODEL_FACES = 1_000_000;
export const MAX_FACES = 1_500_000;
export const MAX_CELLS = 1_800_000;
const EDIT_RESERVE = 200_000;
export const initialPalette = ['#E7DDC8', '#DE7248', '#386D67', '#384956'];
export function bounds(vertices) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) {
    const k = i % 3;
    min[k] = Math.min(min[k], vertices[i]);
    max[k] = Math.max(max[k], vertices[i]);
  }
  const size = max.map((v, k) => v - min[k]);
  return { min, max, size, diagonal: Math.hypot(...size) };
}

export function checkFaceLimit(count) {
  if (count > MAX_FACES) throw Error('This model exceeds the ' + MAX_FACES.toLocaleString() + ' source triangle limit.');
}

export function binarySTLFaceCount(bytes) {
  if (bytes.length < 84) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  return 84 + count * 50 <= bytes.length ? count : 0;
}

export function readSTL(bytes, name) {
  const count = binarySTLFaceCount(bytes);
  const vertices = [],
    faces = [],
    lookup = new Map();
  function triangle(values) {
    if (values.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e12))
      throw Error('The STL contains invalid coordinates.');
    // Test the coordinates at the same precision used by the saved mesh.
    const coords = values.map(Math.fround);
    const ux = coords[3] - coords[0], uy = coords[4] - coords[1], uz = coords[5] - coords[2];
    const vx = coords[6] - coords[0], vy = coords[7] - coords[1], vz = coords[8] - coords[2];
    if (uy * vz === uz * vy && uz * vx === ux * vz && ux * vy === uy * vx) return;
    for (let j = 0; j < 9; j += 3) {
      const point = coords.slice(j, j + 3);
      const key = point.join(',');
      let id = lookup.get(key);
      if (id === undefined) {
        id = vertices.length / 3;
        vertices.push(...point);
        lookup.set(key, id);
      }
      faces.push(id);
    }
    checkFaceLimit(faces.length / 3);
  }
  if (count > 0) {
    checkFaceLimit(count);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count; i++) {
      const start = 84 + i * 50 + 12;
      triangle(Array.from({ length: 9 }, (_, k) => view.getFloat32(start + k * 4, true)));
    }
  } else {
    const source = new TextDecoder().decode(bytes);
    if (!/^\s*solid\b/i.test(source) || !/\bendsolid\b/i.test(source))
      throw Error('Choose a complete binary or ASCII STL file.');
    const facet = /\bfacet\b[^]*?\bendfacet\b/gi;
    for (const [block] of source.matchAll(facet)) {
      const coords = [...block.matchAll(/\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)].flatMap((m) =>
        m.slice(1).map(Number)
      );
      if (coords.length !== 9) throw Error('An STL facet is missing a vertex.');
      triangle(coords);
    }
  }
  if (!faces.length) throw Error('The STL contains no usable triangles.');
  return newProject(
    name.replace(/\.stl$/i, ''),
    Float32Array.from(vertices),
    Uint32Array.from(faces)
  );
}

export function newProject(name, vertices, faces) {
  const count = faces.length / 3;
  checkFaceLimit(count);
  const lengths = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    for (let k = 0; k < 3; k++) {
      const a = faces[f * 3 + k] * 3,
        b = faces[f * 3 + ((k + 1) % 3)] * 3;
      lengths[f] = Math.max(
        lengths[f],
        Math.hypot(
          vertices[a] - vertices[b],
          vertices[a + 1] - vertices[b + 1],
          vertices[a + 2] - vertices[b + 2]
        )
      );
    }
  }
  let step = bounds(vertices).diagonal / 220;
  const depth = new Uint8Array(count);
  let total;
  do {
    total = 0;
    for (let i = 0; i < count; i++) {
      depth[i] = Math.max(0, Math.min(8, Math.ceil(Math.log2(lengths[i] / step))));
      total += 4 ** depth[i];
    }
    step *= 1.2;
  } while (total > Math.min(MAX_CELLS - EDIT_RESERVE, Math.max(340000, count * 1.3)));
  return {
    name,
    vertices,
    faces,
    depth,
    paint: new Uint8Array(total),
    palette: [...initialPalette],
    stamps: [],
  };
}

export function sampleProject() {
  const v = [],
    f = [],
    ringCount = 22,
    sides = 128;
  // Revolve a closed wall section. The hollow lip and concave flutes are actual geometry.
  const profile = [
    [0, 0],
    [13, 0],
  ];
  for (let j = 0; j <= ringCount; j++) {
    const t = j / ringCount;
    profile.push([15 + 9 * Math.sin(Math.PI * t) ** 0.82 + 2.4 * t, 1 + t * 49]);
  }
  profile.push([17.2, 51], [15.3, 51]);
  for (let j = ringCount; j >= 0; j--) {
    const t = j / ringCount;
    profile.push([12.9 + 9 * Math.sin(Math.PI * t) ** 0.82 + 2.4 * t, 3 + t * 47]);
  }
  profile.push([0, 3]);
  const rings = profile.map(([r, z]) => {
    const ids = [];
    for (let i = 0; i < (r ? sides : 1); i++) {
      const a = (2 * Math.PI * i) / sides;
      const radius = r
        ? r + (0.8 + 0.55 * Math.sin((Math.PI * z) / 51)) * Math.cos(16 * a - z * 0.044)
        : 0;
      ids.push(v.length / 3);
      v.push(radius * Math.cos(a), radius * Math.sin(a), z);
    }
    return ids;
  });
  for (let j = 1; j < rings.length; j++)
    for (let i = 0; i < sides; i++) {
      const lo = rings[j - 1],
        hi = rings[j],
        n = (i + 1) % sides;
      if (lo.length === 1) f.push(lo[0], hi[n], hi[i]);
      else if (hi.length === 1) f.push(lo[i], lo[n], hi[0]);
      else f.push(lo[i], lo[n], hi[n], lo[i], hi[n], hi[i]);
    }
  const p = newProject('Fluted vessel', Float32Array.from(v), Uint32Array.from(f));
  for (let i = 0, start = 0; i < p.depth.length; i++) {
    const z = v[f[i * 3] * 3 + 2],
      len = 4 ** p.depth[i];
    p.paint.fill(z > 34 && z < 40 ? 0 : 1, start, start + len);
    start += len;
  }
  return p;
}

export function makeSurface(p) {
  const count = p.paint.length;
  const positions = new Float32Array(count * 9),
    normals = new Float32Array(p.faces.length);
  const owners = new Uint32Array(count);
  const levels = new Uint8Array(count);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  walkPaintCells(
    p,
    (id) => p.vertices.subarray(id * 3, id * 3 + 3),
    mid,
    (a, b, c, id, face, level) => {
      positions.set(a, id * 9);
      positions.set(b, id * 9 + 3);
      positions.set(c, id * 9 + 6);
      owners[id] = face;
      levels[id] = level;
    }
  );
  for (let f = 0; f < p.depth.length; f++) {
    const [a, b, c] = Array.from(p.faces.subarray(f * 3, f * 3 + 3), (id) =>
      p.vertices.subarray(id * 3, id * 3 + 3)
    );
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      len = Math.hypot(nx, ny, nz) || 1;
    normals.set([nx / len, ny / len, nz / len], f * 3);
  }
  return { positions, normals, owners, levels };
}

// Only source-face edges can have different subdivision depths on opposite sides.
// Build adjacency using topological IDs so nearby disconnected shells stay separate.
function adjacency(p) {
  const links = new Int32Array(p.paint.length * 3).fill(-1),
    extra = new Map();
  const edges = new Map(),
    midpoints = new Map();
  const halfEdgeCount = links.length;
  let nextVertex = p.vertices.length / 3;
  const key = (a, b) => Math.min(a, b) * 8388608 + Math.max(a, b);
  function midpoint(a, b) {
    const k = key(a, b);
    if (!midpoints.has(k)) midpoints.set(k, nextVertex++);
    return midpoints.get(k);
  }
  function add(a, b) {
    if (links[a] === -1) links[a] = Math.floor(b / 3);
    else {
      if (!extra.has(a)) extra.set(a, []);
      extra.get(a).push(Math.floor(b / 3));
    }
  }
  function edge(a, b, half) {
    const k = key(a, b),
      mid = midpoints.get(k);
    if (mid !== undefined) {
      edge(a, mid, half);
      edge(mid, b, half);
      return;
    }
    const entry = edges.get(k);
    if (entry === undefined) {
      edges.set(k, half);
      return;
    }
    if (typeof entry === 'number' && entry >= 0) {
      add(half, entry);
      add(entry, half);
      // Preserve both half-edges without creating an array for every manifold edge.
      edges.set(k, -1 - entry * halfEdgeCount - half);
      return;
    }
    const group = Array.isArray(entry)
      ? entry
      : [Math.floor((-1 - entry) / halfEdgeCount), (-1 - entry) % halfEdgeCount];
    for (const neighbor of group) {
      add(half, neighbor);
      add(neighbor, half);
    }
    group.push(half);
    edges.set(k, group);
  }
  // Register all midpoints first so coarse edges discover fine neighbors.
  walkPaintCells(
    p,
    (id) => id,
    midpoint,
    () => {}
  );
  walkPaintCells(
    p,
    (id) => id,
    midpoint,
    (a, b, c, id) => {
      const h = id * 3;
      edge(a, b, h);
      edge(b, c, h + 1);
      edge(c, a, h + 2);
    }
  );
  return { links, extra };
}

export function flood(p, surface, start, angle, protect) {
  if (start < 0 || start >= p.paint.length) return [];
  surface.graph ??= adjacency(p);
  const { links, extra } = surface.graph,
    seed = p.paint[start],
    cutoff = Math.cos((angle * Math.PI) / 180) - 1e-6;
  const seen = new Uint8Array(p.paint.length),
    queue = [start];
  seen[start] = 1;
  for (let pos = 0; pos < queue.length; pos++) {
    const id = queue[pos],
      face = surface.owners[id] * 3,
      n = surface.normals;
    function visit(next) {
      if (next < 0 || seen[next] || (protect && p.paint[next] !== seed)) return;
      const f = surface.owners[next] * 3;
      if (face !== f && n[face] * n[f] + n[face + 1] * n[f + 1] + n[face + 2] * n[f + 2] < cutoff)
        return;
      seen[next] = 1;
      queue.push(next);
    }
    for (let h = id * 3; h < id * 3 + 3; h++) {
      visit(links[h]);
      if (extra.has(h)) for (const other of extra.get(h)) visit(other);
    }
  }
  return queue;
}
