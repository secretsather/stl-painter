import { adjacency } from './mesh.js';

const edgeKey = (a, b) => Math.min(a, b) * 8388608 + Math.max(a, b);

// Only source edges used in more than one render section need stitching.
// First mark shared vertices so large meshes don't need a Map of every edge.
function sectionEdges(mesh, ranges) {
  const owner = new Int32Array(mesh.vertices.length / 3).fill(-1);
  for (const [i, r] of ranges.entries()) {
    for (let k = r.face * 3; k < r.endFace * 3; k++) {
      const id = mesh.faces[k];
      if (owner[id] === -1) owner[id] = i;
      else if (owner[id] !== i) owner[id] = -2;
    }
  }
  const sections = new Map(), shared = new Set();
  for (const [i, r] of ranges.entries()) {
    for (let f = r.face; f < r.endFace; f++) {
      for (let j = 0; j < 3; j++) {
        const a = mesh.faces[3 * f + j], b = mesh.faces[3 * f + (j + 1) % 3];
        if (owner[a] !== -2 || owner[b] !== -2) continue;
        const key = edgeKey(a, b);
        if (!sections.has(key)) sections.set(key, i);
        else if (sections.get(key) !== i) shared.add(key);
      }
    }
  }
  return shared;
}

// Describe boundary leaves by exact dyadic fractions along the original edge.
// Separate sections can subdivide that edge to different depths.
function seamCollector(shared, vertexCount) {
  const points = new Map(), spans = [];
  function segment(a, b, visit) {
    const u = points.get(a), v = points.get(b);
    if (u && v) {
      if (u.key === v.key) visit(u, u.t, v.t);
    } else if (u || v) {
      const point = u ?? v, other = u ? b : a;
      if (other === point.lo || other === point.hi) visit(point, point.t, other === point.lo ? 0 : 1);
    } else if (a < vertexCount && b < vertexCount) {
      const key = edgeKey(a, b);
      if (shared.has(key)) visit({ key, lo: Math.min(a, b), hi: Math.max(a, b) }, 0, 1);
    }
  }
  return {
    spans,
    midpoint(a, b, id) {
      segment(a, b, (line, start, end) => points.set(id, { ...line, t: (start + end) / 2 }));
    },
    edge(a, b, half) {
      segment(a, b, (line, start, end) => spans.push({ key: line.key,
        start: Math.min(start, end), end: Math.max(start, end), half }));
    },
  };
}

export class FillIndex {
  constructor(mesh, ranges) {
    this.mesh = mesh;
    this.shared = sectionEdges(mesh, ranges);
    this.sections = [];
  }
  update(ranges, changes) {
    for (const { index, splits } of changes) {
      const range = ranges[index];
      const seams = seamCollector(this.shared, this.mesh.vertices.length / 3);
      const graph = adjacency({ ...this.mesh, splits }, { ...range, node: 0 }, seams);
      this.sections[index] = { ...graph, spans: seams.spans };
    }
    const links = new Int32Array(ranges[ranges.length - 1].endCell * 3);
    const extra = new Map(), edges = new Map();
    for (const [i, section] of this.sections.entries()) {
      const offset = ranges[i].cell;
      for (let j = 0; j < section.links.length; j++) {
        const neighbor = section.links[j];
        links[3 * offset + j] = neighbor < 0 ? -1 : neighbor + offset;
      }
      for (const [half, neighbors] of section.extra) extra.set(3 * offset + half, neighbors.map(n => n + offset));
      for (const span of section.spans) {
        if (!edges.has(span.key)) edges.set(span.key, []);
        edges.get(span.key).push({ ...span, section: i, half: span.half + offset * 3 });
      }
    }
    function connect(half, other) {
      const cell = Math.floor(other / 3);
      if (links[half] === -1) links[half] = cell;
      else if (links[half] !== cell) {
        if (!extra.has(half)) extra.set(half, []);
        const neighbors = extra.get(half);
        if (!neighbors.includes(cell)) neighbors.push(cell);
      }
    }
    for (const spans of edges.values()) {
      spans.sort((a, b) => a.start - b.start);
      for (let i = 0; i < spans.length; i++) {
        const a = spans[i];
        for (let j = i + 1; j < spans.length && spans[j].start < a.end; j++) {
          const b = spans[j];
          if (a.section === b.section) continue;
          connect(a.half, b.half);
          connect(b.half, a.half);
        }
      }
    }
    return { links, extra };
  }
}
