import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshBVH } from 'three-mesh-bvh';
import { cellHeights } from './color-at-height.js';
import { geometryForProject, displayColors, displayChunk, writeColor } from './display-mesh.js';
import { bounds, sourceNormals } from './mesh.js';
import { bisect, surfaceRanges } from './paint-tree.js';
import { stampFootprint } from './stamp-footprint.js';
import { ViewCube, viewDirections } from './view-cube.js';

// Pole alignment and float32 STL normals can leave a nominally edge-on face
// a few millionths of a radian off parallel to an orthographic viewing ray.
const EDGE_ON_COSINE = 1e-5;

export class Viewport {
  constructor(host, onView) {
    this.host = host;
    this.chunkVersion = 0;
    this.renderer = new T.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    host.prepend(this.renderer.domElement);
    this.canvas = this.renderer.domElement;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#e5e9e5');
    this.scene.add(new T.HemisphereLight(0xfffaf0, 0xc1c4bf, 1.85));
    const sun = new T.DirectionalLight(0xfff3e2, 2.6);
    sun.position.set(-3, -4, 6);
    this.scene.add(sun);
    const fill = new T.DirectionalLight(0xdceeff, 1.05);
    fill.position.set(4, 2, 3);
    this.scene.add(fill);
    this.scene.add(new T.AmbientLight(0xffffff, 0.2));
    this.pickScene = new T.Scene();
    this.target = new T.WebGLRenderTarget(1, 1, {
      minFilter: T.NearestFilter,
      magFilter: T.NearestFilter,
      generateMipmaps: false,
    });
    this.paintMaterial = new T.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      side: T.DoubleSide,
    });
    // Preview two model-space planes in the existing surface draw, so moving
    // the pointer or orbiting never rebuilds the subdivision tree.
    this.bandRange = { value: new T.Vector2(1, 0) };
    this.bandAxis = { value: new T.Vector3(0, 0, 1) };
    this.bandColor = { value: new T.Color() };
    this.bandHasLocks = { value: false };
    this.paintMaterial.defaultAttributeValues = { paintLocked: [0] };
    this.paintMaterial.onBeforeCompile = shader => {
      shader.uniforms.bandRange = this.bandRange;
      shader.uniforms.bandAxis = this.bandAxis;
      shader.uniforms.bandColor = this.bandColor;
      shader.uniforms.bandHasLocks = this.bandHasLocks;
      shader.vertexShader = 'attribute float paintLocked; uniform vec3 bandAxis; varying float locked; varying float bandPosition;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>', '#include <begin_vertex>\nbandPosition = dot(position, bandAxis); locked = paintLocked;');
      shader.fragmentShader = 'varying float locked; varying float bandPosition; uniform bool bandHasLocks; uniform vec2 bandRange; uniform vec3 bandColor;\n' +
        shader.fragmentShader.replace('#include <color_fragment>',
          '#include <color_fragment>\nif (bandPosition >= bandRange.x && bandPosition <= bandRange.y && (!bandHasLocks || locked < 0.5)) diffuseColor.rgb = bandColor;');
    };
    this.pickMaterial = new T.RawShaderMaterial({
      side: T.DoubleSide,
      glslVersion: T.GLSL3,
      uniforms: { firstCell: { value: 0 } },
      vertexShader: `precision highp float;
        uniform mat4 projectionMatrix, modelViewMatrix;
        uniform int firstCell;
        in vec3 position;
        flat out int id;
        void main() {
          id = firstCell + gl_VertexID / 3 + 1;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
        }`,
      fragmentShader: `precision highp float;
        precision highp int;
        flat in int id;
        out vec4 pixel;
        void main() { pixel = vec4(float(id & 255), float((id >> 8) & 255), float(id >> 16), 255.) / 255.; }`,
    });
    this.perspective = new T.PerspectiveCamera(35, 1, 0.1, 1000);
    this.orthographic = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera = this.perspective;
    this.onView = onView;
    this.camera.up.set(0, 0, 1);
    this.cube = new ViewCube(host.querySelector('#view-cube'), (name) => {
      if (this.controls.enabled) this.orient(name);
    });
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: T.MOUSE.PAN, RIGHT: T.MOUSE.ROTATE };
    this.controls.addEventListener('change', () => this.changed());
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }
  setProject(p, prepared) {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    this.project = p;
    const original = geometryForProject(p);
    this.normals = prepared?.normals ?? sourceNormals(p);
    this.tree = prepared ? MeshBVH.deserialize(prepared.tree, original) : new MeshBVH(original, { indirect: true });
    this.raycaster = new T.Raycaster();
    this.samplePoint = new T.Vector3();
    const b = prepared?.box ?? bounds(p.vertices);
    this.box = b;
    this.center = new T.Vector3(...b.min.map((v, i) => v + b.size[i] / 2));
    this.span = b.diagonal || 1;
    const extent = 10 ** Math.floor(Math.log10(this.span)) * 20;
    this.grid = new T.GridHelper(extent, 80, 0xadb7b1, 0xc3ccc5);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.set(this.center.x, this.center.y, b.min[2] - this.span * 0.004);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.scene.add(this.grid);
    this.scene.fog = new T.FogExp2('#e5e9e5', 0.22 / this.span);
    this.rebuildSurface(prepared?.ranges, undefined, prepared);
    this.fit();
    this.restoreCamera(p.editingContext?.camera);
  }
  rebuildSurface(ranges = surfaceRanges(this.project), changed, prepared) {
    const previous = this.chunks ?? [];
    const normals = this.normals;
    this.updateColorLookup();
    previous.forEach((chunk, i) => {
      if (changed && !changed.has(i)) return;
      this.scene.remove(chunk.mesh);
      this.pickScene.remove(chunk.pick);
      chunk.mesh.geometry.dispose();
    });
    this.ranges = ranges;
    const chunks = this.chunks = ranges.map((range, i) => {
      if (changed && !changed.has(i)) {
        previous[i].range = range;
        return previous[i];
      }
      const { data, colorBytes, faceOffsets, flatNormals } =
        prepared?.chunks[i] ?? displayChunk(this.project, range, normals, this.rgb);
      const geometry = new T.BufferGeometry();
      const colors = new T.BufferAttribute(colorBytes, 3, true).setUsage(T.DynamicDrawUsage);
      geometry.setAttribute('position', new T.BufferAttribute(data.positions, 3));
      geometry.setAttribute('normal', new T.BufferAttribute(flatNormals, 3));
      geometry.setAttribute('color', colors);
      const mesh = new T.Mesh(geometry, this.paintMaterial), pick = new T.Mesh(geometry, this.pickMaterial);
      const chunk = { version: ++this.chunkVersion, range, data, mesh, pick, colors, colorBytes, faceOffsets, dirtyStart: Infinity, dirtyEnd: -1 };
      pick.onBeforeRender = () => {
        this.pickMaterial.uniforms.firstCell.value = chunk.range.cell;
        this.pickMaterial.uniformsNeedUpdate = true;
      };
      this.scene.add(mesh);
      this.pickScene.add(pick);
      return chunk;
    });
    // Derive contiguous views only for operations which need all cells. Drawing and
    // editing a chunk retain the local arrays and GPU storage for unaffected chunks.
    const surface = this.surface = {
      normals,
      heightRanges() {
        const heights = new Float32Array(ranges[ranges.length - 1].endCell * 2);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          chunk.heights ??= cellHeights(chunk.data.positions);
          heights.set(chunk.heights, ranges[i].cell * 2);
        }
        return heights;
      },
    };
    Object.defineProperty(surface, 'owners', { configurable: true, get() {
      const owners = new Uint32Array(ranges[ranges.length - 1].endCell);
      for (let i = 0; i < chunks.length; i++) owners.set(chunks[i].data.owners, ranges[i].cell);
      Object.defineProperty(surface, 'owners', { value: owners });
      return owners;
    } });
    this.pickCache = this.lastChunk = null;
    this.draw();
  }

  chunkFor(index, byFace = false) {
    const key = byFace ? 'face' : 'cell', end = byFace ? 'endFace' : 'endCell';
    const recent = this.lastChunk;
    if (recent && index >= recent.range[key] && index < recent.range[end]) return recent;
    let lo = 0, hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index < this.chunks[mid].range[end]) hi = mid;
      else lo = mid + 1;
    }
    return this.lastChunk = this.chunks[lo];
  }

  previewPaint(edits) {
    this.maskedChunks = new Set();
    for (const id of edits.keys()) this.maskedChunks.add(this.chunkFor(id));
    for (const chunk of this.maskedChunks) {
      const original = chunk.pick.geometry, mask = new T.BufferGeometry();
      for (const name of ['position', 'normal', 'color']) mask.setAttribute(name, original.getAttribute(name));
      const {cell, endCell} = chunk.range;
      const index = new Uint32Array((endCell - cell) * 3);
      let size = 0;
      for (let id = cell; id < endCell; id++) {
        if (edits.has(id)) continue;
        const local = (id - cell) * 3;
        index[size++] = local;
        index[size++] = local + 1;
        index[size++] = local + 2;
      }
      mask.setIndex(new T.BufferAttribute(index.subarray(0, size), 1));
      mask.boundingSphere = original.boundingSphere;
      chunk.mesh.geometry = mask;
    }
    const leafCount = (tree) =>
      typeof tree === 'number' ? 1 : leafCount(tree.left) + leafCount(tree.right);
    let leaves = 0;
    for (const tree of edits.values()) leaves += leafCount(tree);
    const positions = new Float32Array(leaves * 9),
      normals = new Float32Array(leaves * 9),
      colors = new Uint8Array(leaves * 9);
    let offset = 0;
    const midpoint = (a, b) => a.clone().lerp(b, 0.5);
    const emit = (tree, tri, normal) => {
      if (typeof tree === 'number') {
        for (const p of tri) {
          p.toArray(positions, offset);
          normals.set(normal, offset);
          colors.set(this.rgb[tree], offset);
          offset += 3;
        }
        return;
      }
      const [left, right] = bisect(...tri, tree.side, midpoint);
      emit(tree.left, left, normal);
      emit(tree.right, right, normal);
    };
    for (const [id, tree] of edits) {
      const chunk = this.chunkFor(id), local = id - chunk.range.cell;
      const n = chunk.data.owners[local] * 3;
      const tri = [0, 3, 6].map((k) =>
        new T.Vector3().fromArray(chunk.data.positions, local * 9 + k)
      );
      emit(tree, tri, this.surface.normals.subarray(n, n + 3));
    }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new T.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new T.BufferAttribute(colors, 3, true));
    this.stampOverlay = new T.Mesh(geometry, this.paintMaterial);
    this.scene.add(this.stampOverlay);
    this.draw();
  }
  clearPaintPreview() {
    if (!this.stampOverlay) return;
    this.scene.remove(this.stampOverlay);
    this.stampOverlay.geometry.dispose();
    this.stampOverlay = null;
    for (const chunk of this.maskedChunks) {
      const mask = chunk.mesh.geometry;
      chunk.mesh.geometry = chunk.pick.geometry;
      for (const name of Object.keys(mask.attributes)) mask.deleteAttribute(name);
      mask.dispose();
    }
    this.maskedChunks.clear();
    this.draw();
  }
  updateColorLookup() {
    this.rgb = displayColors(this.project.palette);
  }
  showBand(low, high, hex, revision, axis = 2) {
    const { paint, lockedSlots } = this.project;
    this.bandHasLocks.value = low <= high && lockedSlots.size > 0;
    if (this.bandHasLocks.value) {
      for (const chunk of this.chunks) {
        if (chunk.lockRevision === revision) continue;
        const { cell, endCell } = chunk.range, geometry = chunk.mesh.geometry;
        let mask = geometry.getAttribute('paintLocked');
        if (!mask) {
          mask = new T.BufferAttribute(new Uint8Array((endCell - cell) * 3), 1);
          geometry.setAttribute('paintLocked', mask);
        }
        for (let id = cell, k = 0; id < endCell; id++, k += 3) {
          mask.array[k] = mask.array[k + 1] = mask.array[k + 2] = Number(lockedSlots.has(paint[id]));
        }
        mask.needsUpdate = true;
        chunk.lockRevision = revision;
      }
    }
    this.bandRange.value.set(low, high);
    this.bandAxis.value.set(0, 0, 0).setComponent(axis, 1);
    if (hex) this.bandColor.value.set(hex);
    this.draw();
  }
  refreshPalette() {
    this.updateColorLookup();
    for (const chunk of this.chunks) {
      const { cell, endCell } = chunk.range;
      for (let id = cell; id < endCell; id++) writeColor(chunk.colorBytes, id - cell, this.rgb[this.project.paint[id]]);
      chunk.colors.clearUpdateRanges();
      chunk.colors.addUpdateRange(0, chunk.colors.array.length);
      chunk.colors.needsUpdate = true;
    }
    this.draw();
  }
  color(id, index) {
    const chunk = this.chunkFor(id), local = id - chunk.range.cell;
    writeColor(chunk.colorBytes, local, this.rgb[index]);
    chunk.dirtyStart = Math.min(chunk.dirtyStart, local);
    chunk.dirtyEnd = Math.max(chunk.dirtyEnd, local);
  }
  showGapColors(targets) {
    if (this.gapTargets === targets) return;
    this.gapTargets = targets;
    for (const chunk of this.chunks) {
      const { cell, endCell } = chunk.range;
      let bytes = chunk.colorBytes;
      if (targets) {
        for (let id = cell; id < endCell; id++) {
          const slot = targets[id];
          if (slot === 255) continue;
          if (bytes === chunk.colorBytes) bytes = bytes.slice();
          writeColor(bytes, id - cell, this.rgb[slot]);
        }
      }
      if (chunk.colors.array === bytes) continue;
      // Reuse the GPU buffer. Keep committed colors available for sampling,
      // history and cancellation, including edits made during the preview.
      chunk.colors.array = bytes;
      chunk.colors.clearUpdateRanges();
      chunk.colors.addUpdateRange(0, bytes.length);
      chunk.colors.needsUpdate = true;
    }
    this.draw();
  }
  recolor() {
    for (const chunk of this.chunks) {
      if (chunk.dirtyEnd < 0) continue;
      chunk.colors.addUpdateRange(chunk.dirtyStart * 9, (chunk.dirtyEnd - chunk.dirtyStart + 1) * 9);
      chunk.colors.needsUpdate = true;
      chunk.dirtyStart = Infinity;
      chunk.dirtyEnd = -1;
    }
    this.draw();
  }
  resize() {
    this.w = Math.max(1, this.host.clientWidth);
    this.h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(this.w, this.h, false);
    this.target.setSize(this.w, this.h);
    this.updateProjection();
    this.changed();
  }
  updateProjection() {
    const aspect = this.w / this.h,
      span = this.span || 1;
    this.perspective.aspect = aspect;
    for (const cam of [this.perspective, this.orthographic]) {
      cam.up.set(0, 0, 1);
      cam.near = span / 2000;
      cam.far = span * 100;
    }
    const half = this.half || span;
    Object.assign(this.orthographic, {
      left: -half * aspect,
      right: half * aspect,
      top: half,
      bottom: -half,
    });
    this.perspective.updateProjectionMatrix();
    this.orthographic.updateProjectionMatrix();
  }
  setCamera(mode) {
    const next = mode === 'ortho' ? this.orthographic : this.perspective;
    if (next === this.camera) return;
    const dir = this.camera.position.clone().sub(this.controls.target);
    const slope = Math.tan((35 * Math.PI) / 360);
    if (next === this.orthographic) {
      this.half = dir.length() * slope;
      next.zoom = 1;
    } else dir.setLength(this.half / this.orthographic.zoom / slope);
    next.position.copy(this.controls.target).add(dir);
    this.camera = next;
    this.controls.object = next;
    this.updateProjection();
    this.controls.update();
    this.changed();
  }
  cameraState() {
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      projection: this.camera.isOrthographicCamera ? 'ortho' : 'perspective',
      ...(this.camera.isOrthographicCamera && { half: this.half, zoom: this.camera.zoom }),
    };
  }
  restoreCamera(state) {
    const validPoint = (p) => Array.isArray(p) && p.length === 3 &&
      p.every((n) => Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER);
    if (!validPoint(state?.position) || !validPoint(state.target) ||
        state.position.every((n, i) => n === state.target[i])) return;
    const ortho = state.projection === 'ortho';
    if (!ortho && state.projection !== 'perspective') return;
    if (ortho && !(Number.isFinite(state.half) && state.half > 0 &&
        state.half <= Number.MAX_SAFE_INTEGER && state.zoom >= this.controls.minZoom &&
        state.zoom <= this.controls.maxZoom && Number.isFinite(state.zoom))) return;
    this.setCamera(state.projection);
    if (ortho) {
      this.half = state.half;
      this.orthographic.zoom = state.zoom;
      this.updateProjection();
    }
    this.controls.target.fromArray(state.target);
    this.camera.position.fromArray(state.position);
    this.controls.update();
    this.changed();
  }
  fit(view = 'Studio') {
    if (!this.center) return;
    const distance = this.span * 1.75 * Math.max(1, this.h / this.w);
    this.controls.target.copy(this.center);
    this.controls.minDistance = this.span * 0.015;
    this.controls.maxDistance = this.span * 18;
    this.controls.minZoom = 0.08;
    this.controls.maxZoom = 75;
    this.half = distance * Math.tan((35 * Math.PI) / 360);
    this.orthographic.zoom = 1;
    this.updateProjection();
    this.orient(view, distance);
  }
  orient(view, distance = this.camera.position.distanceTo(this.controls.target)) {
    this.lookFrom(viewDirections[view].clone(), distance);
  }
  alignToFace(point) {
    const hit = this.surfaceHit(point);
    if (!hit) return false;
    const normal = hit.face.normal;
    if (normal.dot(this.raycaster.ray.direction) > 0) normal.negate();
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.controls.target.copy(hit.point);
    this.lookFrom(normal, distance);
    return true;
  }
  lookFrom(direction, distance) {
    // At either pole a tiny azimuth reference keeps +X pointing right.
    if (Math.abs(direction.z) === 1) direction.y = -1e-6;
    this.camera.position.copy(this.controls.target).add(direction.setLength(distance));
    this.controls.update();
    this.changed();
  }
  changed() {
    this.pickCache = null;
    this.draw();
    this.onView?.(this.cube.update(this.camera));
  }
  draw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
    });
  }
  picks() {
    if (this.pickCache) return this.pickCache;
    const { renderer, w, h } = this;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0, 1);
    renderer.render(this.pickScene, this.camera);
    const rgba = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(this.target, 0, 0, w, h, rgba);
    renderer.setRenderTarget(null);
    let edgeOn = null;
    const { normals } = this.surface;
    if (this.camera.isOrthographicCamera) {
      const ray = this.camera.getWorldDirection(new T.Vector3());
      edgeOn = new Uint8Array(normals.length / 3);
      for (let face = 0; face < edgeOn.length; face++) {
        const k = face * 3;
        const facing = normals[k] * ray.x + normals[k + 1] * ray.y + normals[k + 2] * ray.z;
        edgeOn[face] = Math.abs(facing) <= EDGE_ON_COSINE;
      }
    }
    const owners = edgeOn && this.surface.owners;
    const ids = new Int32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const src = ((h - 1 - y) * w + x) * 4;
        const id = (rgba[src] | (rgba[src + 1] << 8) | (rgba[src + 2] << 16)) - 1;
        ids[y * w + x] = id >= 0 && edgeOn?.[owners[id]] ? -1 : id;
      }
    this.pickCache = { ids, edgeOn };
    return this.pickCache;
  }
  surfaceHit({ x, y }) {
    const { camera } = this;
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera({ x: 2 * x / this.w - 1, y: 1 - 2 * y / this.h }, camera);
    const ray = this.raycaster.ray;
    const forward = ray.direction.dot(camera.getWorldDirection(this.samplePoint));
    return this.tree.raycastFirst(ray, T.DoubleSide, camera.near / forward, camera.far / forward);
  }
  bandPositionAt(point, axis) {
    const hit = this.surfaceHit(point), span = this.box.size[axis], base = this.box.min[axis];
    let position = hit?.point.getComponent(axis);
    if (!hit) {
      // Project the positive model axis onto the canvas. Off-model clicks
      // past the visible silhouette snap to the corresponding physical end.
      const basis = this.camera.matrixWorld.elements;
      const dx = basis[axis], dy = -basis[4 + axis], length = Math.hypot(dx, dy);
      const endOn = length < 0.0142;
      const ux = endOn ? 0 : dx / length, uy = endOn ? -1 : dy / length;
      const cache = this.picks();
      cache.bandExtents ??= [];
      if (!cache.bandExtents[axis]) {
        let min = Infinity, max = -Infinity;
        for (let y = 0, i = 0; y < this.h; y++) {
          for (let x = 0; x < this.w; x++, i++) {
            if (cache.ids[i] < 0) continue;
            const t = x * ux + y * uy;
            min = Math.min(min, t);
            max = Math.max(max, t);
          }
        }
        cache.bandExtents[axis] = [min, max];
      }
      const [min, max] = cache.bandExtents[axis];
      const t = Math.floor(point.x) * ux + Math.floor(point.y) * uy;
      if (min <= max && t < min) return 0;
      if (min <= max && t > max) return span;
      if (endOn && max > min) return span * (t - min) / (max - min);
      const forward = this.camera.getWorldDirection(this.samplePoint);
      const ray = this.raycaster.ray;
      const distance = this.center.clone().sub(ray.origin).dot(forward) / ray.direction.dot(forward);
      position = ray.origin.getComponent(axis) + distance * ray.direction.getComponent(axis);
    }
    if (position >= this.box.max[axis]) return span;
    return Math.max(0, Math.min(span, Number((position - base).toFixed(3))));
  }
  pixelsPerMillimeter(point) {
    const { camera } = this;
    const scale = this.h * camera.projectionMatrix.elements[5] / 2;
    if (camera.isOrthographicCamera) return scale;
    const hit = this.surfaceHit(point);
    // At an empty pixel, keep the preview in the orbit target's depth plane.
    const depth = -this.samplePoint.copy(hit?.point ?? this.controls.target)
      .applyMatrix4(camera.matrixWorldInverse).z;
    return scale / Math.max(camera.near, depth);
  }
  pick(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return this.picks().ids[Math.floor(y) * this.w + Math.floor(x)];
  }
  stroke(a, b, r, apply) {
    const { ids } = this.picks(),
      dx = b.x - a.x,
      dy = b.y - a.y,
      len = dx * dx + dy * dy;
    const cells = this.visibleCells();
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r)),
      x1 = Math.min(this.w - 1, Math.ceil(Math.max(a.x, b.x) + r));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r)),
      y1 = Math.min(this.h - 1, Math.ceil(Math.max(a.y, b.y) + r));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const t = len ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0;
        if ((x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 <= r * r) {
          const pixel = y * this.w + x,
            id = ids[pixel];
          if (id >= 0) apply(id);
          for (let sub = cells.head[pixel]; sub !== -1; sub = cells.next[sub]) {
            if (this.visibleAtCenter(sub, cells)) apply(sub);
          }
        }
      }
  }
  visibleCells() {
    const cache = this.picks();
    if (cache.visible) return cache.visible;
    const count = this.project.paint.length,
      sx = new Float64Array(count),
      sy = new Float64Array(count),
      ns = new Uint32Array(count);
    const { ids } = cache,
      active = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const id = ids[y * this.w + x];
        if (id < 0) continue;
        if (!ns[id]) active.push(id);
        sx[id] += x;
        sy[id] += y;
        ns[id]++;
      }
    for (const id of active) {
      sx[id] /= ns[id];
      sy[id] /= ns[id];
    }
    // Select a real visible pixel nearest the visible patch's center, including partial occlusion.
    const best = new Int32Array(count).fill(-1),
      dist = new Float32Array(count).fill(Infinity);
    for (let pos = 0; pos < ids.length; pos++) {
      const id = ids[pos];
      if (id < 0) continue;
      const d = ((pos % this.w) - sx[id]) ** 2 + (Math.floor(pos / this.w) - sy[id]) ** 2;
      if (d < dist[id]) {
        dist[id] = d;
        best[id] = pos;
      }
    }
    const head = new Int32Array(ids.length).fill(-1),
      next = new Int32Array(count);
    const visibility = new Int8Array(count);
    for (let id = 0; id < count; id++) {
      if (cache.edgeOn?.[this.surface.owners[id]]) continue;
      if (ns[id]) {
        visibility[id] = 1;
        continue;
      }
      const point = this.projectCenter(id);
      if (Math.abs(point.z) > 1) continue;
      const x = Math.floor(((1 + point.x) * this.w) / 2),
        y = Math.floor(((1 - point.y) * this.h) / 2);
      if (x < 0 || x >= this.w || y < 0 || y >= this.h) continue;
      const pixel = y * this.w + x;
      next[id] = head[pixel];
      head[pixel] = id;
      best[id] = pixel;
      active.push(id);
    }
    return (cache.visible = { active, best, head, next, visibility });
  }
  projectCenter(id) {
    const chunk = this.chunkFor(id), pos = chunk.data.positions,
      k = (id - chunk.range.cell) * 9;
    return this.samplePoint
      .set(
        (pos[k] + pos[k + 3] + pos[k + 6]) / 3,
        (pos[k + 1] + pos[k + 4] + pos[k + 7]) / 3,
        (pos[k + 2] + pos[k + 5] + pos[k + 8]) / 3
      )
      .project(this.camera);
  }
  visibleAtCenter(id, cells) {
    if (cells.visibility[id] === 0) {
      // A subpixel cell may never win a raster sample. Test its own viewing ray.
      this.raycaster.setFromCamera(this.projectCenter(id), this.camera);
      const hit = this.tree.raycastFirst(this.raycaster.ray, T.DoubleSide);
      cells.visibility[id] = hit?.faceIndex === this.surface.owners[id] ? 1 : -1;
    }
    return cells.visibility[id] === 1;
  }
  stampFootprint(stamp, placement) {
    const footprint = stampFootprint(stamp, placement);
    if (!placement.filter) return footprint;
    const n = this.surface.normals,
      eye = this.camera.position;
    const fixed = this.camera.getWorldDirection(new T.Vector3()).negate(),
      limit = Math.cos((placement.cutoff * Math.PI) / 180);
    footprint.accepts = (id) => {
      const chunk = this.chunkFor(id), local = id - chunk.range.cell;
      const pos = chunk.data.positions, f = chunk.data.owners[local] * 3, k = local * 9;
      let vx = fixed.x,
        vy = fixed.y,
        vz = fixed.z;
      if (this.camera.isPerspectiveCamera) {
        vx = eye.x - (pos[k] + pos[k + 3] + pos[k + 6]) / 3;
        vy = eye.y - (pos[k + 1] + pos[k + 4] + pos[k + 7]) / 3;
        vz = eye.z - (pos[k + 2] + pos[k + 5] + pos[k + 8]) / 3;
      }
      return (n[f] * vx + n[f + 1] * vy + n[f + 2] * vz) / Math.hypot(vx, vy, vz) >= limit - 1e-6;
    };
    return footprint;
  }
  // During a drag use only the visible pixels under the artwork. The pick
  // buffer is cached for this view, so moving needs no subdivision or raycasts.
  dragStamp(footprint) {
    const ids = this.picks().ids,
      result = new Map();
    const left = Math.max(0, Math.floor(footprint.xmin));
    const right = Math.min(this.w, Math.ceil(footprint.xmax));
    const top = Math.max(0, Math.floor(footprint.ymin));
    const bottom = Math.min(this.h, Math.ceil(footprint.ymax));
    const point = { x: 0, y: 0 };
    for (let y = top; y < bottom; y++) {
      point.y = y + 0.5;
      for (let x = left; x < right; x++) {
        const id = ids[y * this.w + x];
        if (id < 0 || result.has(id) || this.project.lockedSlots?.has(this.project.paint[id])) continue;
        point.x = x + 0.5;
        const color = footprint.sample(point);
        if (color !== 255 && (!footprint.accepts || footprint.accepts(id))) result.set(id, color);
      }
    }
    return result;
  }
  stamp(footprint) {
    const cells = this.visibleCells(),
      result = new Map();
    for (const id of cells.active) {
      if (this.project.lockedSlots?.has(this.project.paint[id])) continue;
      const pixel = cells.best[id];
      const color = footprint.sample({
        x: (pixel % this.w) + 0.5,
        y: Math.floor(pixel / this.w) + 0.5,
      });
      if (color === 255 || (footprint.accepts && !footprint.accepts(id))) continue;
      if (this.visibleAtCenter(id, cells)) result.set(id, color);
    }
    return result;
  }
  lassoCells(footprint) {
    const {ids} = this.picks(), cells = this.visibleCells(), edits = new Map();
    const add = (id, color) => {
      const original = this.project.paint[id];
      if (color !== original && !this.project.lockedSlots.has(original)) edits.set(id, color);
    };
    const point = { x: 0, y: 0 };
    for (let y = footprint.ymin; y < footprint.ymax; y++) {
      point.y = y + 0.5;
      for (let x = footprint.xmin; x < footprint.xmax; x++) {
        const pixel = y * this.w + x;
        if (ids[pixel] < 0 && cells.head[pixel] < 0) continue;
        point.x = x + 0.5;
        const color = footprint.sample(point);
        if (color === 255) continue;
        if (ids[pixel] >= 0) add(ids[pixel], color);
        for (let sub = cells.head[pixel]; sub !== -1; sub = cells.next[sub]) {
          if (this.visibleAtCenter(sub, cells)) add(sub, color);
        }
      }
    }
    return edits;
  }
}
