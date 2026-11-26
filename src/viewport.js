import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshBVH } from 'three-mesh-bvh';
import { bounds, makeSurface } from './mesh.js';
import { bisect } from './paint-tree.js';
import { stampFootprint } from './stamp-footprint.js';
import { ViewCube, viewDirections } from './view-cube.js';

// Pole alignment and float32 STL normals can leave a nominally edge-on face
// a few millionths of a radian off parallel to an orthographic viewing ray.
const EDGE_ON_COSINE = 1e-5;

export class Viewport {
  constructor(host, onView) {
    this.host = host;
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
    this.pickMaterial = new T.RawShaderMaterial({
      side: T.DoubleSide,
      vertexShader:
        'precision highp float; uniform mat4 projectionMatrix,modelViewMatrix; attribute vec3 position,cell; varying vec3 key; void main(){ key=cell; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader:
        'precision highp float; varying vec3 key; void main(){gl_FragColor=vec4(key,1.);}',
    });
    this.perspective = new T.PerspectiveCamera(35, 1, 0.1, 1000);
    this.orthographic = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera = this.perspective;
    this.onView = onView;
    this.camera.up.set(0, 0, 1);
    this.cube = new ViewCube(host.querySelector('#view-cube'), (name) => this.orient(name));
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: T.MOUSE.PAN, RIGHT: T.MOUSE.ROTATE };
    this.controls.addEventListener('change', () => this.changed());
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }
  setProject(p) {
    if (this.mesh) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    this.project = p;
    const original = new T.BufferGeometry();
    original.setAttribute('position', new T.BufferAttribute(p.vertices, 3));
    original.setIndex(new T.BufferAttribute(p.faces, 1));
    this.tree = new MeshBVH(original, { indirect: true });
    this.raycaster = new T.Raycaster();
    this.samplePoint = new T.Vector3();
    const b = bounds(p.vertices);
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
    this.rebuildSurface();
    this.fit();
    this.restoreCamera(p.editingContext?.camera);
  }
  rebuildSurface() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.pickScene.remove(this.pickMesh);
      this.mesh.geometry.dispose();
    }
    this.pickCache = null;
    this.surface = makeSurface(this.project);
    const { positions, owners, normals } = this.surface;
    const geo = new T.BufferGeometry(),
      colors = new Uint8Array(positions.length),
      ids = new Uint8Array(positions.length);
    const flatNormals = new Float32Array(positions.length);
    for (let id = 0; id < owners.length; id++) {
      const n = owners[id] * 3,
        k = id + 1;
      for (let j = id * 9; j < id * 9 + 9; j += 3) {
        flatNormals[j] = normals[n];
        flatNormals[j + 1] = normals[n + 1];
        flatNormals[j + 2] = normals[n + 2];
        ids[j] = k & 255;
        ids[j + 1] = (k >> 8) & 255;
        ids[j + 2] = (k >> 16) & 255;
      }
    }
    geo.setAttribute('position', new T.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new T.BufferAttribute(flatNormals, 3));
    geo.setAttribute('cell', new T.BufferAttribute(ids, 3, true));
    this.colors = new T.BufferAttribute(colors, 3, true).setUsage(T.DynamicDrawUsage);
    geo.setAttribute('color', this.colors);
    this.mesh = new T.Mesh(geo, this.paintMaterial);
    this.pickMesh = new T.Mesh(geo, this.pickMaterial);
    this.scene.add(this.mesh);
    this.pickScene.add(this.pickMesh);
    this.refreshPalette();
  }

  previewPaint(edits) {
    // The display mesh can reuse the existing GPU buffers for untouched cells.
    // Picking and saving continue to use the committed project throughout.
    const original = this.pickMesh.geometry;
    const mask = new T.BufferGeometry();
    for (const name of ['position', 'normal', 'color'])
      mask.setAttribute(name, original.getAttribute(name));
    const count = this.surface.owners.length;
    const index = new Uint32Array((count - edits.size) * 3);
    for (let id = 0, i = 0; id < count; id++) {
      if (edits.has(id)) continue;
      index[i++] = id * 3;
      index[i++] = id * 3 + 1;
      index[i++] = id * 3 + 2;
    }
    mask.setIndex(new T.BufferAttribute(index, 1));
    mask.boundingSphere = original.boundingSphere;
    this.mesh.geometry = mask;

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
      const n = this.surface.owners[id] * 3;
      const tri = [0, 3, 6].map((k) =>
        new T.Vector3().fromArray(this.surface.positions, id * 9 + k)
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
    const mask = this.mesh.geometry;
    this.mesh.geometry = this.pickMesh.geometry;
    // The committed mesh owns the shared attributes. Dispose only the mask index.
    for (const name of Object.keys(mask.attributes)) mask.deleteAttribute(name);
    mask.dispose();
    this.draw();
  }
  refreshPalette() {
    this.rgb = this.project.palette.map((hex) => {
      const c = new T.Color(hex);
      return [c.r, c.g, c.b].map((v) => Math.round(v * 255));
    });

    const a = this.colors.array;
    for (let i = 0; i < this.project.paint.length; i++) this.color(i, this.project.paint[i], a);
    this.colors.needsUpdate = true;
    this.draw();
  }
  color(id, index, a = this.colors.array) {
    const [r, g, b] = this.rgb[index];
    for (let j = id * 9; j < id * 9 + 9; j += 3) {
      a[j] = r;
      a[j + 1] = g;
      a[j + 2] = b;
    }
  }
  recolor() {
    this.colors.needsUpdate = true;
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
    const { owners, normals } = this.surface;
    if (this.camera.isOrthographicCamera) {
      const ray = this.camera.getWorldDirection(new T.Vector3());
      edgeOn = new Uint8Array(normals.length / 3);
      for (let face = 0; face < edgeOn.length; face++) {
        const k = face * 3;
        const facing = normals[k] * ray.x + normals[k + 1] * ray.y + normals[k + 2] * ray.z;
        edgeOn[face] = Math.abs(facing) <= EDGE_ON_COSINE;
      }
    }
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
    const pos = this.surface.positions,
      k = id * 9;
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
      pos = this.surface.positions,
      eye = this.camera.position;
    const fixed = this.camera.getWorldDirection(new T.Vector3()).negate(),
      limit = Math.cos((placement.cutoff * Math.PI) / 180);
    footprint.accepts = (id) => {
      const f = this.surface.owners[id] * 3,
        k = id * 9;
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
        if (id < 0 || result.has(id)) continue;
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
}
