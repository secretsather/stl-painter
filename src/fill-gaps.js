// Measure the triangle along and across the incoming edge, in surface mm.
function edgeCoordinates(positions, cell, half, triangle) {
  const edge = half % 3, offset = Math.floor(half / 3) * 9;
  const a = offset + edge * 3, b = offset + (edge + 1) % 3 * 3;
  const dx = positions[b] - positions[a], dy = positions[b + 1] - positions[a + 1];
  const dz = positions[b + 2] - positions[a + 2], length = Math.hypot(dx, dy, dz);
  if (!length) return null;
  for (let i = 0; i < 3; i++) {
    const k = cell * 9 + i * 3, point = triangle[i];
    const x = positions[k] - positions[a], y = positions[k + 1] - positions[a + 1];
    const z = positions[k + 2] - positions[a + 2];
    point[0] = (x * dx + y * dy + z * dz) / length;
    if ((x === 0 && y === 0 && z === 0) || (x === dx && y === dy && z === dz)) point[1] = 0;
    else point[1] = Math.hypot(y * dz - z * dy, z * dx - x * dz, x * dy - y * dx) / length;
  }
  return triangle;
}

function unfold(positions, cell, half, parent, triangle = [[0, 0], [0, 0], [0, 0]], frames) {
  let local;
  if (frames && parent) {
    // A coarse edge can lead into several different refined triangles.
    const slot = half % frames.length;
    let entry = frames[slot];
    if (!entry || entry.half !== half || entry.cell !== cell) {
      local = edgeCoordinates(positions, cell, half, entry?.local ?? [[0, 0], [0, 0], [0, 0]]);
      frames[slot] = { half, cell, local };
    } else local = entry.local;
  } else local = edgeCoordinates(positions, cell, half, triangle);
  if (!local || !parent) return local;

  const edge = half % 3, a = parent[edge], b = parent[(edge + 1) % 3];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = !dx ? Math.abs(dy) : !dy ? Math.abs(dx) : Math.hypot(dx, dy);
  const side = -Math.sign(cross(a, b, parent[(edge + 2) % 3]));
  if (!length || !side) return null;
  const ux = dx / length, uy = dy / length;
  for (let i = 0; i < 3; i++) {
    const along = local[i][0], across = local[i][1] * side;
    triangle[i][0] = a[0] + along * ux - across * uy;
    triangle[i][1] = a[1] + along * uy + across * ux;
  }
  return triangle;
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function convexHull(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  function half(start, stop, step) {
    const hull = [];
    for (let i = start; i !== stop; i += step) {
      const p = points[i];
      while (hull.length >= 2 && cross(hull.at(-2), hull.at(-1), p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  }
  return half(0, points.length, 1).concat(half(points.length - 1, -1, -1));
}

// The farthest pair lies on the convex hull. Rotating calipers avoid
// comparing every pair of vertices on highly subdivided paint.
function withinDiameter(hull, limit) {
  for (let i = 0, j = 1; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    while (cross(a, b, hull[(j + 1) % hull.length]) > cross(a, b, hull[j])) j = (j + 1) % hull.length;
    for (const p of [a, b]) if (Math.hypot(p[0] - hull[j][0], p[1] - hull[j][1]) > limit) return false;
  }
  return true;
}

function fitsSurface(positions, cells, parents, count, limit) {
  const triangles = new Map();
  let points = [], compactAt = 8192, oldest = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const parent = i === 0 ? 0 : Math.floor(parents[i] / 3);
    const edge = cells[parent] * 3 + (i === 0 ? 0 : parents[i] % 3);
    // Parents are consumed in breadth-first order. Keep just the frontier.
    while (oldest < parent) triangles.delete(oldest++);
    const triangle = unfold(positions, cells[i], edge, triangles.get(parent));
    if (!triangle) return false;
    triangles.set(i, triangle);
    for (const point of triangle) {
      minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
      minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
      points.push(point);
    }
    if (maxX - minX > limit || maxY - minY > limit) return false;
    if (points.length >= compactAt) {
      points = convexHull(points);
      compactAt = 8192 + points.length * 2;
    }
  }
  return Math.hypot(maxX - minX, maxY - minY) <= limit || withinDiameter(convexHull(points), limit);
}

// A coarse edge may meet several finer triangles. Split the edge at the
// actual shared endpoints so a cross-section only enters the face it meets.
function edgeSpans(graph, positions, half, cache) {
  const first = graph.links[half], extra = graph.extra.get(half);
  if (!extra) return [[0, 1, first]];
  if (cache.has(half)) return cache.get(half);
  const cell = Math.floor(half / 3), k = half * 3;
  const end = cell * 9 + (half + 1) % 3 * 3;
  const dx = positions[end] - positions[k], dy = positions[end + 1] - positions[k + 1];
  const dz = positions[end + 2] - positions[k + 2], length2 = dx * dx + dy * dy + dz * dz;
  function fraction(i) {
    return ((positions[i] - positions[k]) * dx + (positions[i + 1] - positions[k + 1]) * dy +
      (positions[i + 2] - positions[k + 2]) * dz) / length2;
  }
  const spans = [];
  for (const next of new Set([first, ...extra])) {
    for (let h = next * 3; h < next * 3 + 3; h++) {
      if (graph.links[h] !== cell && !graph.extra.get(h)?.includes(cell)) continue;
      const a = fraction(h * 3), b = fraction(next * 9 + (h + 1) % 3 * 3);
      const lo = Math.max(0, Math.min(a, b)), hi = Math.min(1, Math.max(a, b));
      if (hi > lo) spans.push([lo, hi, next]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  // Overlapping neighbors signal a non-manifold branch with no unique path.
  const safe = spans.some((s, i) => i && s[0] < spans[i - 1][1] - 1e-7) ? [] : spans;
  cache.set(half, safe);
  return safe;
}

function everyNeighbor(graph, cell, matches) {
  for (let h = cell * 3; h < cell * 3 + 3; h++) {
    if (!matches(graph.links[h])) return false;
    const extra = graph.extra.get(h);
    if (extra && !extra.every(matches)) return false;
  }
  return true;
}

// Sweep perpendicular cross-sections inward from each painted border. In the
// unfolded plane the starting edge sits at y=0, so y measures surface width.
// An interval of rays covers small refined cells between coarse edge endpoints.
function addThinSeams(paint, locked, graph, positions, limit, targets, candidates, queue, patches, onProgress) {
  const proposals = new Uint8Array(paint.length).fill(255), ambiguous = new Set(), spans = new Map();
  let nearest, distances;
  const active = new Uint8Array(paint.length);
  const stack = [], spare = [];
  // Nearby sweeps often cross the same directed edge. Its local coordinates
  // are fixed even when the incoming sweep has a different orientation.
  const frames = new Array(Math.min(8192, graph.links.length));
  function pushCell(cell, half, lo, hi, parent) {
    const node = spare.pop() ?? { triangle: [[0, 0], [0, 0], [0, 0]], entered: false,
      cell: 0, parent: null, lo: 0, hi: 0, center: 0 };
    if (!unfold(positions, cell, half, parent?.triangle, node.triangle, frames)) {
      spare.push(node);
      return;
    }
    if (!parent) {
      const length = node.triangle[(half + 1) % 3][0];
      lo *= length;
      hi *= length;
    }
    node.cell = cell; node.lo = lo; node.hi = hi; node.parent = parent;
    stack.push(node);
  }
  function offerBank(cell, slot, distance) {
    if (!nearest) {
      nearest = new Uint8Array(paint.length).fill(255);
      distances = new Float64Array(paint.length);
    }
    const delta = distance - distances[cell];
    const tie = Math.max(1, distance, distances[cell]) * 1e-8;
    if (nearest[cell] === 255 || delta < -tie || (Math.abs(delta) <= tie && slot < nearest[cell])) {
      nearest[cell] = slot;
      distances[cell] = distance;
    }
  }
  function propose(node, lo, hi, target, farBank) {
    for (let step = node; step; step = step.parent) {
      const { cell, center } = step;
      if (center < lo || center > hi || targets[cell] !== 255) continue;
      // Apply recolors whole leaves. A ray grazing a corner must not pull a
      // large triangle from the wide part of the patch into the result.
      if (step.triangle.some(p => p[1] < -limit * 1e-7 || p[1] > limit)) continue;
      if (farBank) {
        const y = (step.triangle[0][1] + step.triangle[1][1] + step.triangle[2][1]) / 3;
        offerBank(cell, target, Math.abs(y));
        // Unfolded distances from the centroid to the actual opposing edge span.
        const {x0, y0, dx, dy, length2, slot} = farBank;
        const t = Math.max(0, Math.min(1, ((center-x0)*dx + (y-y0)*dy)/length2));
        offerBank(cell, slot, Math.hypot(center-x0-t*dx, y-y0-t*dy));
      } else if (proposals[cell] !== 255 && proposals[cell] !== target) ambiguous.add(cell);
      else proposals[cell] = target;
    }
  }
  function sweep(seed, half, lo, hi, target) {
    pushCell(seed, half, lo, hi, null);
    while (stack.length) {
      const node = stack.pop();
      const { cell, triangle: tri } = node;
      if (node.entered) {
        node.entered = false;
        active[cell] = 0;
        spare.push(node);
        continue;
      }
      active[cell] = 1;
      node.entered = true;
      stack.push(node); // Recycle only after all child paths have finished.
      node.center = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
      const winding = Math.sign(cross(tri[0], tri[1], tri[2]));
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3], dx = b[0] - a[0], dy = b[1] - a[1];
        if (dx * winding >= 0) continue; // Only edges the rays can exit.
        const h = cell * 3 + e;
        const parts = graph.extra.size && graph.extra.has(h) ? edgeSpans(graph, positions, h, spans) : null;
        for (let i = 0; i < (parts ? parts.length : 1); i++) {
          const part = parts?.[i], next = part ? part[2] : graph.links[h];
          if (next < 0 || active[next]) continue;
          const x0 = part ? a[0] + part[0] * dx : a[0], x1 = a[0] + (part ? part[1] : 1) * dx;
          let left = Math.max(node.lo, Math.min(x0, x1)), right = Math.min(node.hi, Math.max(x0, x1));
          if (dy === 0) {
            if (a[1] > limit) continue;
          } else {
            const atLimit = a[0] + (limit - a[1]) * dx / dy;
            if (dy / dx > 0) right = Math.min(right, atLimit);
            else left = Math.max(left, atLimit);
          }
          if (right <= left) continue;
          if (paint[next] === paint[seed]) {
            pushCell(next, h, left, right, node);
          } else if (patches[next] !== PINHOLE) {
            if (paint[next] === target) {
              // A short return to the same color can just be a corner.
              if (Math.abs(dx) >= Math.abs(dy)) propose(node, left, right, target);
            } else if (patches[seed] === TWO_BANKS) {
              // A jagged opposite bank can be steep even when the whole strip
              // fits the width. supportedSeam checks sustained contact with both banks.
              const y0 = a[1] + (part ? part[0]*dy : 0);
              const spanDy = part ? (part[1]-part[0])*dy : dy, spanDx = x1-x0;
              propose(node, left, right, target, {x0, y0, dx:spanDx, dy:spanDy,
                length2:spanDx*spanDx + spanDy*spanDy, slot:paint[next]});
            }
          }
        }
      }
    }
  }
  const progressStep = Math.ceil(paint.length / 100);
  for (let cell = 0; cell < paint.length; cell++) {
    if (onProgress && cell % progressStep === 0) onProgress(Math.floor(100 * cell / paint.length));
    if (locked.has(paint[cell]) || targets[cell] !== 255) continue;
    for (let h = cell * 3; h < cell * 3 + 3; h++) {
      const first = graph.links[h];
      if (first < 0 || (paint[first] === paint[cell] && !graph.extra.has(h))) continue;
      for (const [lo, hi, next] of edgeSpans(graph, positions, h, spans)) {
        if (next >= 0 && patches[next] !== PINHOLE && paint[next] !== paint[cell]) sweep(cell, h, lo, hi, paint[next]);
      }
    }
  }
  // Reject cells touching an opening or a third swatch. Group the remaining
  // local sections for the same preview count and reciprocal-fill checks as pinholes.
  for (let id = 0; id < paint.length; id++) {
    const target = proposals[id];
    if (target === 255) continue;
    const safe = n => n >= 0 && (paint[n] === paint[id] || paint[n] === target);
    if (ambiguous.has(id) || !everyNeighbor(graph, id, safe)) {
      proposals[id] = 255;
    } else if (patches[id] === TWO_BANKS && nearest && nearest[id] === 255 &&
        everyNeighbor(graph, id, n => paint[n] !== paint[id] || nearest[n] !== 255)) {
      // A pointed end can meet the same bank on both long sides. Keep its
      // measured color with the strip when all adjoining seam cells qualified.
      nearest[id] = target;
    }
  }
  if (nearest) {
    collectSeams(nearest, true, paint, graph, positions, targets, queue, candidates, patches, spans);
    for (let id = 0; id < proposals.length; id++) if (targets[id] !== 255) proposals[id] = 255;
  }
  collectSeams(proposals, false, paint, graph, positions, targets, queue, candidates, patches, spans);
}

function collectSeams(proposals, twoBanks, paint, graph, positions, targets, queue, candidates, patches, spans) {
  for (let seed = 0; seed < proposals.length; seed++) {
    const target = proposals[seed];
    if (target === 255 || targets[seed] !== 255) continue;
    // Whole-triangle and open-edge filtering can disconnect the middle of
    // a sweep from both borders. Grow only from surviving bank contact.
    if (!twoBanks) {
      const isBank = n => n >= 0 && paint[n] === target && patches[n] !== PINHOLE;
      let touchesBank = false;
      for (let h = seed * 3; !touchesBank && h < seed * 3 + 3; h++)
        touchesBank = isBank(graph.links[h]) || graph.extra.get(h)?.some(isBank);
      if (!touchesBank) continue;
    }
    let size = 1;
    queue[0] = seed;
    targets[seed] = target;
    function visit(n) {
      if (n < 0 || proposals[n] === 255 || (!twoBanks && proposals[n] !== target) ||
          paint[n] !== paint[seed] || targets[n] !== 255) return;
      targets[n] = proposals[n];
      queue[size++] = n;
    }
    for (let i = 0; i < size; i++) {
      for (let h = queue[i] * 3; h < queue[i] * 3 + 3; h++) {
        visit(graph.links[h]);
        graph.extra.get(h)?.forEach(visit);
      }
    }
    // An entire third-color fleck can be one sliver with two long bank edges.
    // A single suggested face cut out of a larger patch is still just a notch.
    const isolatedFleck = size === 1 && twoBanks && everyNeighbor(graph, seed, n => n >= 0 && paint[n] !== paint[seed]);
    if ((size > 1 || isolatedFleck) && supportedSeam(queue, size, proposals, paint, target, graph, positions, spans, twoBanks)) {
      candidates.push(queue.slice(0, size));
    } else {
      for (let i = 0; i < size; i++) {
        targets[queue[i]] = 255;
        proposals[queue[i]] = 255;
      }
    }
  }
}

// A square notch in a straight paint boundary has three sides against the
// target and one side open to its original color. Require stronger support
// than that for a seam. Measure shared lengths, not numbers of triangles.
function supportedSeam(cells, size, proposals, paint, target, graph, positions, spans, twoBanks) {
  let bank = 0, opening = 0, area = 0;
  const contacts = twoBanks ? new Map() : null;
  for (let i = 0; i < size; i++) {
    const id = cells[i];
    if (twoBanks) {
      const k = 9*id;
      const ax = positions[k+3]-positions[k], ay = positions[k+4]-positions[k+1], az = positions[k+5]-positions[k+2];
      const bx = positions[k+6]-positions[k], by = positions[k+7]-positions[k+1], bz = positions[k+8]-positions[k+2];
      area += 0.5*Math.hypot(ay*bz-az*by, az*bx-ax*bz, ax*by-ay*bx);
    }
    for (let h = 3 * id; h < 3 * id + 3; h++) {
      const other = graph.links[h];
      if (!graph.extra.has(h) && other >= 0 && paint[other] === paint[id] &&
          (twoBanks ? proposals[other] !== 255 : proposals[other] === target)) continue;
      const a = h * 3, b = 9 * id + 3 * ((h + 1) % 3);
      const length = Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1],
        positions[a + 2] - positions[b + 2]);
      const segments = edgeSpans(graph, positions, h, spans);
      if (!segments.length) return false;
      let openFraction = 1;
      for (const [lo, hi, next] of segments) {
        if (next < 0) continue;
        if (paint[next] === target || (twoBanks && paint[next] !== paint[id])) {
          const contact = (hi-lo)*length;
          bank += contact;
          if (contacts) contacts.set(paint[next], (contacts.get(paint[next]) ?? 0) + contact);
        } else if (paint[next] !== paint[id] || (twoBanks ? proposals[next] === 255 : proposals[next] !== target)) continue;
        openFraction -= hi - lo;
      }
      opening += Math.max(0, openFraction) * length;
    }
  }
  // Each bank must run alongside the strip. A short contact on a speck or
  // an end cap cannot establish a long, narrow seam between different colors.
  if (contacts && (contacts.size !== 2 || Math.min(...contacts.values())**2 <= 3*area)) return false;
  return bank > 3 * opening * (1 + 1e-6);
}

export function hasMultipleSwatches(paint) {
  const first = paint[0];
  for (let i = 1; i < paint.length; i++) if (paint[i] !== first) return true;
  return false;
}

const PINHOLE = 2; // Visited paint patch small enough to be a pinhole, even if locked.
const TWO_BANKS = 3; // Third-color patch bounded by exactly two swatches and no open mesh edges.

export function findGaps(paint, locked, graph, positions, threshold, includeSeams = false, onProgress) {
  const targets = new Uint8Array(paint.length).fill(255);
  if (!Number.isFinite(threshold) || threshold <= 0 || !hasMultipleSwatches(paint)) return { targets, count: 0 };
  const limit = threshold * (1 + 1e-7);
  const visited = new Uint8Array(paint.length), cells = new Uint32Array(paint.length);
  const parents = new Uint32Array(paint.length), candidates = [];
  for (let seed = 0; seed < paint.length; seed++) {
    const color = paint[seed];
    if (visited[seed] || (!includeSeams && locked.has(color))) continue;
    let size = 1, border = -1, second = -1, possible = true, enclosed = true;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    cells[0] = seed;
    visited[seed] = 1;
    function visit(id, parentEdge) {
      if (id < 0) enclosed = possible = false; // Open mesh boundary.
      else if (paint[id] !== color) {
        if (border < 0) border = paint[id];
        else if (border !== paint[id]) {
          possible = false;
          if (second < 0) second = paint[id];
          else if (second !== paint[id]) enclosed = false;
        }
      } else if (!visited[id]) {
        visited[id] = 1;
        cells[size] = id;
        parents[size++] = parentEdge;
      }
    }
    for (let i = 0; i < size; i++) {
      const cell = cells[i];
      for (let h = cell * 3; h < cell * 3 + 3; h++) {
        const parentEdge = i * 3 + h % 3;
        visit(graph.links[h], parentEdge);
        const others = graph.extra.get(h);
        if (others) for (const other of others) visit(other, parentEdge);
      }
      if (!possible) continue;
      for (let k = cell * 9; k < cell * 9 + 9; k += 3) {
        for (let axis = 0; axis < 3; axis++) {
          const v = positions[k + axis];
          min[axis] = Math.min(min[axis], v);
          max[axis] = Math.max(max[axis], v);
          if (max[axis] - min[axis] > limit) possible = false;
        }
      }
    }
    if (includeSeams && enclosed && second >= 0 && !locked.has(color)) {
      for (let i = 0; i < size; i++) visited[cells[i]] = TWO_BANKS;
    }
    if (!possible || border < 0 || !fitsSurface(positions, cells, parents, size, limit)) continue;
    if (includeSeams) for (let i = 0; i < size; i++) visited[cells[i]] = PINHOLE;
    if (locked.has(color)) continue;
    const ids = cells.slice(0, size);
    for (const id of ids) targets[id] = border;
    candidates.push(ids);
  }
  if (includeSeams) addThinSeams(paint, locked, graph, positions, limit, targets, candidates, cells, visited, onProgress);
  // On a tiny two-color shell both regions can appear to enclose the other.
  // Suppress reciprocal fills instead of swapping their colors on Apply.
  const conflicts = candidates.filter(ids => ids.some(id => {
    for (let h = id * 3; h < id * 3 + 3; h++) {
      if (targets[graph.links[h]] === paint[id] || graph.extra.get(h)?.some(n => targets[n] === paint[id])) return true;
    }
    return false;
  }));
  for (const ids of conflicts) for (const id of ids) targets[id] = 255;
  return { targets, count: candidates.length - conflicts.length };
}
