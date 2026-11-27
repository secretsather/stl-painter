import * as T from 'three';
import { MAX_CELLS } from './mesh.js';
import { bisect, MAX_EDGE_DEPTH } from './paint-tree.js';

const TARGET_PX = 1;
const MAX_NEW_CELLS_PER_STROKE = 400000;
const midpoint = (a, b) => a.clone().lerp(b, 0.5);

function distanceToStroke(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function screenPoint(world, view, out = new T.Vector3()) {
  out.copy(world).project(view.camera);
  out.x = ((1 + out.x) * view.w) / 2;
  out.y = ((1 - out.y) * view.h) / 2;
  return out;
}

function viewDepth(p, camera) {
  const m = camera.matrixWorldInverse.elements;
  return -(m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]);
}

function clippedProjection(triangle, view) {
  let polygon = triangle;
  for (const [limit, sign] of [
    [view.camera.near, 1],
    [view.camera.far, -1],
  ]) {
    const clipped = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      const da = (viewDepth(a, view.camera) - limit) * sign,
        db = (viewDepth(b, view.camera) - limit) * sign;
      if (da >= 0) clipped.push(a);
      if (da >= 0 !== db >= 0) clipped.push(a.clone().lerp(b, da / (da - db)));
    }
    polygon = clipped;
  }
  return polygon.map((p) => screenPoint(p, view));
}

// Bounds include thin cells whose tip crosses the brush while their centroid
// and all raster sample locations miss it. Cache them for this camera pose.
function* footprintCells(view, cache, { xmin, xmax, ymin, ymax }) {
  // Crop the camera frustum to this footprint. The BVH visits each intersecting
  // source-face range once, including occluded faces and subpixel triangles.
  const width = xmax - xmin + 2, height = ymax - ymin + 2;
  const projection = new T.Matrix4().set(
    view.w / width, 0, 0, (view.w - xmin - xmax) / width,
    0, view.h / height, 0, (ymin + ymax - view.h) / height,
    0, 0, 1, 0, 0, 0, 0, 1
  ).multiply(view.camera.projectionMatrix).multiply(view.camera.matrixWorldInverse);
  const frustum = new T.Frustum().setFromProjectionMatrix(projection);
  const faces = [];
  view.tree.shapecast({
    intersectsBounds: box => frustum.intersectsBox(box),
    intersectsRange(offset, count) {
      for (let i = offset; i < offset + count; i++) faces.push(view.tree.resolveTriangleIndex(i));
      return false;
    },
  });
  faces.sort((a, b) => a - b);
  const pt = new T.Vector3();
  cache.strokeBounds ??= new Map();
  for (const face of faces) {
    if (cache.edgeOn?.[face]) continue;
    const chunk = view.chunkFor(face, true);
    const f = face - chunk.range.face;
    const start = chunk.faceOffsets[f], end = chunk.faceOffsets[f + 1];
    let tile = cache.strokeBounds.get(chunk);
    if (!tile) {
      tile = { bounds: new Float32Array(chunk.data.owners.length * 4),
        ready: new Uint8Array(chunk.faceOffsets.length - 1) };
      cache.strokeBounds.set(chunk, tile);
    }
    const bounds = tile.bounds;
    if (!tile.ready[f]) {
      const { positions } = chunk.data;
      for (let id = start; id < end; id++) {
        let left = Infinity,
          right = -Infinity,
          top = Infinity,
          bottom = -Infinity,
          clipped = 0;

        for (let k = id * 9; k < id * 9 + 9; k += 3) {
          pt.fromArray(positions, k);
          screenPoint(pt, view, pt);
          left = Math.min(left, pt.x);
          right = Math.max(right, pt.x);
          top = Math.min(top, pt.y);
          bottom = Math.max(bottom, pt.y);
          if (pt.z < -1 || pt.z > 1) clipped++;
        }
        if (clipped) {
          const triangle = [0, 3, 6].map((j) => new T.Vector3().fromArray(positions, id * 9 + j));
          const polygon = clippedProjection(triangle, view);
          left = Math.min(...polygon.map((p) => p.x));
          right = Math.max(...polygon.map((p) => p.x));
          top = Math.min(...polygon.map((p) => p.y));
          bottom = Math.max(...polygon.map((p) => p.y));
        }
        const k = id * 4;
        bounds[k] = left;
        bounds[k + 1] = right;
        bounds[k + 2] = top;
        bounds[k + 3] = bottom;
      }
      tile.ready[f] = 1;
    }
    for (let local = start; local < end; local++) {
      const k = local * 4;
      if (bounds[k] <= xmax && bounds[k + 1] >= xmin && bounds[k + 2] <= ymax && bounds[k + 3] >= ymin) {
        yield chunk.range.cell + local;
      }
    }
  }
}

export class RefinedStroke {
  constructor(view, color) {
    this.view = view;
    this.color = color;
    this.edits = new Map();
    this.remaining = Math.min(MAX_NEW_CELLS_PER_STROKE, MAX_CELLS - view.project.paint.length);
    // Continuous single-color strokes draw each dab immediately. A stamp
    // previews its entire multi-color edit using the display mesh instead.
    if (color !== undefined) {
      this.overlay = new T.Group();
      this.material = view.paintMaterial.clone();
      this.material.vertexColors = false;
      this.material.color.fromArray(view.rgb[color].map((v) => v / 255));
      this.material.polygonOffset = true;
      this.material.polygonOffsetFactor = -1;
      this.material.polygonOffsetUnits = -1;
      view.scene.add(this.overlay);
    }
    this.probe = new T.Vector3();
    this.ndc = new T.Vector2();
  }

  visible(point, face) {
    const v = this.view;
    if (
      point.z < -1 ||
      point.z > 1 ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= v.w ||
      point.y >= v.h
    )
      return false;
    this.ndc.set((point.x * 2) / v.w - 1, 1 - (point.y * 2) / v.h);
    v.raycaster.setFromCamera(this.ndc, v.camera);
    return v.tree.raycastFirst(v.raycaster.ray, T.DoubleSide)?.faceIndex === face;
  }

  dab(a, b, radius) {
    this.projectFootprint({
      xmin: Math.min(a.x, b.x) - radius,
      xmax: Math.max(a.x, b.x) + radius,
      ymin: Math.min(a.y, b.y) - radius,
      ymax: Math.max(a.y, b.y) + radius,
      classify: (screen, longest) => {
        const farthest = Math.max(...screen.map((p) => distanceToStroke(p, a, b)));
        if (farthest - longest > radius) return 255;
        return farthest <= radius ? this.color : -1;
      },
      sample: (p) => (distanceToStroke(p, a, b) <= radius ? this.color : 255),
    });
  }

  projectFootprint(footprint) {
    const { xmin, xmax, ymin, ymax } = footprint;
    const v = this.view,
      cache = v.picks();
    const { normals } = v.surface;
    const painted = [],
      flatNormals = [];
    const paint = (triangle, face, color) => {
      if (!this.overlay) return color;
      for (const vertex of triangle) {
        painted.push(vertex.x, vertex.y, vertex.z);
        const n = face * 3;
        flatNormals.push(normals[n], normals[n + 1], normals[n + 2]);
      }
      return color;
    };
    const visit = (tree, triangle, face, level) => {
      if (tree === this.color) return tree;
      const screen = triangle.map((p) => screenPoint(p, v));
      const clipped = screen.some((p) => p.z < -1 || p.z > 1 || !Number.isFinite(p.z));
      if (clipped) {
        const polygon = clippedProjection(triangle, v);
        if (
          !polygon.length ||
          polygon.every((p) => p.x < xmin) ||
          polygon.every((p) => p.x > xmax) ||
          polygon.every((p) => p.y < ymin) ||
          polygon.every((p) => p.y > ymax)
        )
          return tree;
      }
      const lengths = screen.map((p, i) =>
        Math.hypot(p.x - screen[(i + 1) % 3].x, p.y - screen[(i + 1) % 3].y)
      );
      const longest = Math.max(...lengths);
      const coverage = clipped ? -1 : footprint.classify(screen, longest);
      if (coverage === 255 || coverage === tree) return tree;
      const split = (side, left, right) => {
        const children = bisect(...triangle, side, midpoint);
        const first = visit(left, children[0], face, level + 1);
        const second = visit(right, children[1], face, level + 1);
        if (first === second && typeof first === 'number') return first;
        return { side, left: first, right: second };
      };
      if (typeof tree !== 'number') {
        const updated = split(tree.side, tree.left, tree.right);
        // A later dab can cover both children of an earlier boundary.
        if (typeof updated === 'number') this.remaining++;
        return updated;
      }

      const centerWorld = triangle[0]
        .clone()
        .add(triangle[1])
        .add(triangle[2])
        .multiplyScalar(1 / 3);
      const center = screenPoint(centerWorld, v, this.probe);
      const color = coverage < 0 ? footprint.sample(center) : coverage;
      if (!clipped && longest <= TARGET_PX)
        return color !== 255 && color !== tree && this.visible(center, face)
          ? paint(triangle, face, color)
          : tree;

      if (!clipped && (coverage >= 0 || !this.overlay)) {
        // A raster ID from another face inside this triangle may mark an
        // occluder. Split along that boundary, too, before changing its paint.
        const visible = this.visible(center, face);
        if (
          (coverage >= 0 || !visible) &&
          this.uniformVisibility(screen, face, visible, cache) &&
          triangle.every(
            (vertex) =>
              this.visible(screenPoint(vertex.clone().lerp(centerWorld, 0.001), v), face) ===
              visible
          )
        )
          return visible ? paint(triangle, face, color) : tree;
      }
      if (!this.remaining || level >= MAX_EDGE_DEPTH) {
        this.limited = true;
        return !clipped &&
          color !== 255 &&
          color !== tree &&
          this.visible(center, face) &&
          this.uniformVisibility(screen, face, true, cache)
          ? paint(triangle, face, color)
          : tree;
      }
      const edges = clipped
        ? triangle.map((p, i) => p.distanceToSquared(triangle[(i + 1) % 3]))
        : lengths;
      const side = ((edges.indexOf(Math.max(...edges)) + 2) % 3) + 1;
      this.remaining--;
      const result = split(side, tree, tree);
      if (typeof result === 'number') this.remaining++;
      return result;
    };
    for (const id of footprintCells(v, cache, footprint)) {
      if (v.project.lockedSlots?.has(v.project.paint[id])) continue;
      const chunk = v.chunkFor(id), local = id - chunk.range.cell;
      const { positions, owners, levels } = chunk.data;
      const old = this.edits.get(id) ?? v.project.paint[id];
      if (old === this.color || (footprint.accepts && !footprint.accepts(id))) continue;
      const tri = [0, 3, 6].map((j) => new T.Vector3().fromArray(positions, local * 9 + j));
      const updated = visit(old, tri, owners[local], levels[local]);
      if (updated !== old) this.edits.set(id, updated);
    }
    if (painted.length) {
      const geometry = new T.BufferGeometry();
      geometry.setAttribute('position', new T.Float32BufferAttribute(painted, 3));
      geometry.setAttribute('normal', new T.Float32BufferAttribute(flatNormals, 3));
      this.overlay.add(new T.Mesh(geometry, this.material));
      v.draw();
    }
  }

  uniformVisibility(tri, face, expected, cache) {
    const [a, b, c] = tri,
      v = this.view;
    const cross = (p, q, x, y) => (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
    const sign = Math.sign(cross(a, b, c.x, c.y));
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))),
      x1 = Math.min(v.w - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))),
      y1 = Math.min(v.h - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (
          cross(a, b, x + 0.5, y + 0.5) * sign <= 0 ||
          cross(b, c, x + 0.5, y + 0.5) * sign <= 0 ||
          cross(c, a, x + 0.5, y + 0.5) * sign <= 0
        )
          continue;
        const id = cache.ids[y * v.w + x];
        if ((id >= 0 && v.surface.owners[id] === face) !== expected) return false;
      }
    return true;
  }

  dispose() {
    if (!this.overlay) return;
    this.view.scene.remove(this.overlay);
    for (const mesh of this.overlay.children) mesh.geometry.dispose();
    this.material.dispose();
    this.view.draw();
  }
}
