import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Points,
  ShaderMaterial,
  Triangle,
  Vector3,
} from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { UNIT, world } from './seam-geometry.js';
import { projectSegment, editableSegments } from './seam-projection.js';
import { lassoCubics } from './lasso.js';

// A wide line or circular handle straddles neighboring screen pixels. Test its
// attachment to the model once per centerline location, so a steep bevel
// cannot shave off the camera-facing half of an otherwise visible guide.
const seamClip = 'varying vec4 seamClip;';
const originSize = 16,
  nodeSize = 12;
const seamVisibility = `
  uniform highp sampler2D modelDepth;
  varying vec4 seamClip;
  bool hiddenSeam() {
    vec3 anchor = 0.5 * (seamClip.xyz / seamClip.w) + 0.5;
    ivec2 size = textureSize(modelDepth, 0);
    ivec2 lo = ivec2(floor(anchor.xy * vec2(size) - 0.5));
    // The anchor may lie between samples at a crease or silhouette.
    float depth = 0.0;
    for (int y=0; y<2; ++y) for (int x=0; x<2; ++x) {
      ivec2 pixel = clamp(lo + ivec2(x,y), ivec2(0), size-1);
      depth = max(depth, texelFetch(modelDepth, pixel, 0).r);
    }
    return anchor.z > depth + 2.0 / 16777215.0;
  }`;

function lineLayer(view, seams, draft) {
  const group = new Group(),
    positions = [];
  for (const seam of seams)
    for (const [f, a, b] of seam.edges) {
      positions.push(...world(view.project, f, a), ...world(view.project, f, b));
    }
  if (positions.length) {
    const geo = new LineSegmentsGeometry().setPositions(positions);
    const strokes = [
      [draft ? 7 : 6, 0x182629],
      [draft ? 4 : 3, draft ? 0xffdf41 : 0xff64be],
    ];
    for (const [index, [width, color]] of strokes.entries()) {
      const mat = new LineMaterial({
        color,
        linewidth: width,
        depthTest: false,
        depthWrite: false,
      });
      mat.uniforms.modelDepth = { value: view.target.depthTexture };
      mat.vertexShader =
        seamClip +
        '\n' +
        mat.vertexShader.replace(
          'gl_Position = clip;',
          'seamClip = position.y < 0.5 ? clipStart : clipEnd; gl_Position = clip;'
        );
      mat.fragmentShader =
        seamVisibility +
        '\n' +
        mat.fragmentShader.replace('void main() {', 'void main() { if (hiddenSeam()) discard;');
      const line = new LineSegments2(geo, mat);
      line.renderOrder = (draft ? 6 : 3) + index;
      group.add(line);
    }
  }
  return group;
}
function markers(view, nodes) {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      nodes.flatMap((n) => world(view.project, n.face, n.uv)),
      3
    )
  );
  const material = new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      scale: { value: view.renderer.getPixelRatio() },
      modelDepth: { value: view.target.depthTexture },
    },
    vertexShader: `${seamClip}
      uniform float scale;
      varying float first;
      void main() {
        first = gl_VertexID == 0 ? 1.0 : 0.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        seamClip = gl_Position;
        gl_PointSize = (first > 0.0 ? ${originSize}.0 : ${nodeSize}.0) * scale;
      }`,
    fragmentShader: `${seamVisibility}
      varying float first;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        if (r > 0.48 || hiddenSeam()) discard;
        vec3 fill = first > 0.0 ? vec3(1.0, 0.85, 0.2) : vec3(1.0);
        bool ring = r > 0.34 || (first > 0.0 && r < 0.14);
        gl_FragColor = vec4(ring ? vec3(0.09) : fill, 1.0);
      }`,
  });
  const obj = new Points(geometry, material);
  obj.renderOrder = 9;
  return obj;
}
function dispose(group, view) {
  if (!group) return;
  view.scene.remove(group);
  const geometries = new Set();
  for (const obj of group.children) {
    geometries.add(obj.geometry);
    obj.material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
}

export class SeamEditor {
  constructor(view, notify, commit, rename) {
    this.view = view;
    view.hasVisibleSeams = () =>
      this.activeLayer?.children.length || (this.savedLayer?.visible && this.savedLayer.children.length);
    this.notify = notify;
    this.commit = commit;
    this.rename = rename;
    const el = (id) => document.getElementById(id);
    this.apply = el('apply-seam');
    this.list = el('seam-list');
    this.remove = el('remove-seam');
    this.toggle = el('show-seams');
    this.smooth = el('smooth-seam');
    this.smooth.onchange = () => {
      const d = this.draft;
      if (d && d.runStart < d.segments.length) {
        const run = this.liveRun(d.nodes, d.closed);
        const indices = Array.from({ length: d.segments.length - d.runStart }, (_, i) => i);
        if (
          !this.changeSegments(() => {
            const paths = this.trace(run.nodes, run.closed, indices);
            paths.forEach((path, i) => {
              d.segments[d.runStart + i] = path;
            });
          })
        ) {
          this.smooth.checked = !this.smooth.checked;
          return;
        }
        d.rollback = [];
        this.updateGuide();
      }
      view.canvas.focus({ preventScroll: true });
    };
    this.apply.onclick = () => this.finish();
    this.toggle.onclick = () => {
      this.toggle.setAttribute(
        'aria-pressed',
        String(this.toggle.getAttribute('aria-pressed') !== 'true')
      );
      this.updateVisibility();
      view.canvas.focus({ preventScroll: true });
    };
    this.remove.onclick = () => {
      const index = this.draft?.index;
      if (index >= 0) {
        this.cancel();
        this.commit(
          'Removed seam',
          view.project.seams.filter((_, i) => i !== index),
          -1
        );
      }
    };
  }
  get visible() {
    return this.toggle.getAttribute('aria-pressed') === 'true';
  }
  updateVisibility() {
    const show = !this.toggle.hidden && this.visible;
    if (this.savedLayer && this.savedLayer.visible !== show) {
      this.savedLayer.visible = show;
      this.view.draw();
    }
  }
  edit(index) {
    const seam = this.view.project.seams[index];
    const parts = editableSegments(this.view.project, seam);
    this.smooth.checked = seam.smooth === true;
    this.draft = { ...parts, closed: seam.closed, index, runStart: parts.segments.length, rollback: [] };
    this.updateGuide();
    this.showSaved();
  }
  renderList() {
    const seams = this.view.project.seams ?? [],
      index = this.draft?.index ?? -1;
    // Selection changes during the first click of a double-click. Keep the
    // original target in place until the saved seams themselves change.
    if (this.listSeams === seams) {
      for (const row of this.list.querySelectorAll('[data-seam]')) {
        row.setAttribute('aria-pressed', String(Number(row.dataset.seam) === index));
      }
      return;
    }
    this.listSeams = seams;
    this.list.replaceChildren(...seams.map((s, i) => {
      const entry = document.createElement('div');
      entry.className = 'seam-entry';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'seam-row';
      row.dataset.seam = String(i);
      row.setAttribute('aria-pressed', String(i === index));
      const state = document.createElement('span');
      state.textContent = s.closed ? 'Closed' : 'Open';
      const label = document.createElement('span');
      const name = s.name || 'Seam ' + (i + 1);
      label.textContent = name;
      row.title = name + ' · Double-click or press F2 to rename';
      row.setAttribute('aria-keyshortcuts', 'F2');
      row.append(label, state);
      const startRename = () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('aria-label', 'Seam name');
        input.value = name;
        row.hidden = true;
        entry.append(input);
        const close = () => {
          input.onblur = null;
          input.remove();
          row.hidden = false;
        };
        input.onblur = close;
        input.onkeydown = event => {
          event.stopPropagation();
          if (event.isComposing || (event.key !== 'Escape' && event.key !== 'Enter')) return;
          event.preventDefault();
          const value = input.value.trim();
          close();
          if (event.key === 'Enter' && value !== name) this.rename(i, value);
          this.list.querySelector('[data-seam="' + i + '"]')?.focus({preventScroll:true});
        };
        input.focus();
        input.select();
      };
      row.ondblclick = startRename;
      row.onkeydown = event => {
        if (event.key === 'F2') {
          event.preventDefault();
          startRename();
        }
      };
      entry.append(row);
      return entry;
    }));
  }
  showSaved() {
    const seams = this.view.project.seams ?? [], index = this.draft?.index ?? -1;
    this.renderList();
    this.remove.hidden = index < 0;
    dispose(this.savedLayer, this.view);
    this.savedLayer = lineLayer(
      this.view,
      seams.filter((_, i) => i !== index),
      false
    );
    this.savedLayer.visible = !this.toggle.hidden && this.visible;
    this.view.scene.add(this.savedLayer);
    this.view.draw();
  }
  cancel() {
    const editing = this.draft?.index >= 0;
    this.draft = this.result = this.drag = null;
    this.redraw();
    if (editing) this.showSaved();
  }
  redraw(preview = null, pendingNode = null) {
    dispose(this.activeLayer, this.view);
    const paths = preview ? preview.segments.map(edges => ({ edges })) : this.result ? [this.result.seam] : [];
    this.activeLayer = lineLayer(this.view, paths, true);
    let nodes = preview?.nodes ?? this.draft?.nodes ?? [];
    if (pendingNode) {
      nodes = nodes.slice();
      nodes[this.drag.index < 0 ? nodes.length : this.drag.index] = pendingNode;
    }
    if (nodes.length) this.activeLayer.add(markers(this.view, nodes));
    this.apply.disabled = !this.result || !!this.drag;
    this.view.scene.add(this.activeLayer);
    this.view.draw();
  }
  nodeAt(pt) {
    if (pt.x < 0 || pt.y < 0 || pt.x >= this.view.w || pt.y >= this.view.h) return null;
    const v = this.view,
      hit = v.surfaceHit(pt);
    if (!hit) return null;
    const f = hit.faceIndex,
      p = v.project,
      tri = [0, 1, 2].map((k) => new Vector3().fromArray(p.vertices, 3 * p.faces[3 * f + k]));
    const bary = Triangle.getBarycoord(hit.point, ...tri, new Vector3());
    if (!bary) return null;
    const u = Math.min(UNIT, Math.max(0, Math.round(bary.y * UNIT)));
    return { face: f, uv: [u, Math.min(UNIT - u, Math.max(0, Math.round(bary.z * UNIT)))] };
  }
  markerAt(pt, maxDistance = Infinity) {
    const v = this.view,
      nodes = this.draft?.nodes ?? [];
    let best = -1,
      bestDistance = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i],
        xyz = new Vector3(...world(v.project, n.face, n.uv)),
        q = xyz.clone().project(v.camera);
      const x = ((q.x + 1) * v.w) / 2,
        y = ((1 - q.y) * v.h) / 2,
        d = Math.hypot(pt.x - x, pt.y - y);
      if (
        q.z < -1 ||
        q.z > 1 ||
        d > Math.min(maxDistance, (i === 0 ? originSize : nodeSize) / 2) ||
        d >= bestDistance
      )
        continue;
      const hit = v.surfaceHit({ x, y });
      if (!hit || hit.point.distanceTo(xyz) > v.span * 0.00001) continue;
      best = i;
      bestDistance = d;
    }
    return best;
  }
  down(pt, event) {
    if (this.drag) return;
    const n = this.nodeAt(pt);
    if (!n) {
      this.notify('Click the model to place a seam node.');
      return;
    }
    this.draft ??= { index: -1, nodes: [], segments: [], closed: false, runStart: 0, rollback: [] };
    const index = this.markerAt(pt);
    if (index < 0 && this.draft.closed) {
      this.notify('The loop is closed. Apply it, or press Backspace to reopen it.');
      return;
    }
    this.drag = { index, pt, id: event.pointerId };
    this.view.canvas.setPointerCapture(event.pointerId);
    this.apply.disabled = true;
    this.move(pt, event);
  }
  freezeView() {
    if (this.draft) this.draft.runStart = this.draft.segments.length;
  }
  liveRun(nodes, closed) {
    const start = this.draft.runStart;
    const run = nodes.slice(start);
    if (closed && start > 0) run.push(nodes[0]);
    return { nodes: run, closed: closed && start === 0 };
  }
  extendedDraft(node, closed) {
    const d = this.draft;
    const nodes = closed ? d.nodes : [...d.nodes, node];
    if (!d.nodes.length) return { ...d, nodes };
    const run = this.liveRun(nodes, closed);
    const last = d.segments.length - d.runStart;
    const indices = [last];
    if (this.smooth.checked && last > 0) {
      indices.push(last - 1);
      if (run.closed && last > 1) indices.push(0);
    }
    const paths = this.trace(run.nodes, run.closed, indices);
    const segments = d.segments.slice();
    // Keep the old tangent shapes so Backspace can restore them after orbiting.
    const previous = indices.slice(1).map(i => [d.runStart + i, segments[d.runStart + i]]);
    indices.forEach((i, k) => {
      segments[d.runStart + i] = paths[k];
    });
    return { ...d, nodes, segments, closed, rollback: [...d.rollback, previous] };
  }
  trace(nodes, closed, indices) {
    const view = this.view;
    let curves;
    if (this.smooth.checked && nodes.length > 2) {
      const points = nodes.map((n) => {
        const q = new Vector3(...world(view.project, n.face, n.uv)).project(view.camera);
        return { x: ((1 + q.x) * view.w) / 2, y: ((1 - q.y) * view.h) / 2 };
      });
      curves = lassoCubics(points, closed);
    }
    return indices.map((i) => {
      const from = nodes[i],
        to = nodes[(i + 1) % nodes.length];
      if (!curves) return this.project(from, to);
      const [a, b, c, d] = curves[i];
      // A cubic's second derivative bounds the error of each straight chord.
      // Subdivide until the preview deviates by at most a quarter screen pixel.
      const bend = (p, q, r) => Math.hypot(p.x - 2 * q.x + r.x, p.y - 2 * q.y + r.y);
      const steps = Math.max(1, Math.ceil(Math.sqrt(3 * Math.max(bend(a, b, c), bend(b, c, d)))));
      if (!Number.isFinite(steps)) throw Error('Place the next seam node at a distinct visible point.');
      const edges = [];
      let previous = from;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps,
          u = 1 - t;
        const at = (axis) =>
          u ** 3 * a[axis] + 3 * u * u * t * b[axis] + 3 * u * t * t * c[axis] + t ** 3 * d[axis];
        const next = k === steps ? to : this.nodeAt({ x: at('x'), y: at('y') });
        if (!next) throw Error('The curve leaves the model. Add a closer node or turn off Smooth seam.');
        for (const edge of this.project(previous, next)) edges.push(edge);
        previous = next;
      }
      return edges;
    });
  }
  movedDraft(index, node) {
    const d = this.draft, nodes = d.nodes.slice(), segments = d.segments.slice();
    nodes[index] = node;
    if (d.runStart === 0) {
      // The two neighboring tangents also change when a smooth node moves.
      const offsets = this.smooth.checked ? [-2, -1, 0, 1] : [-1, 0];
      const indices = [
        ...new Set(
          offsets
            .map((offset) => index + offset)
            .map((i) => (d.closed ? (i + nodes.length) % nodes.length : i))
            .filter((i) => i >= 0 && i < segments.length)
        ),
      ];
      this.trace(nodes, d.closed, indices).forEach((path, k) => {
        segments[indices[k]] = path;
      });
    } else {
      // An explicit edit to a frozen or saved seam only moves its incident paths.
      const incoming = (index + nodes.length - 1) % nodes.length;
      const indices = [incoming, index].filter((i) => i < segments.length);
      const local = [nodes[indices[0]], ...indices.map((i) => nodes[(i + 1) % nodes.length])];
      this.trace(
        local,
        false,
        indices.map((_, k) => k)
      ).forEach((path, k) => {
        segments[indices[k]] = path;
      });
    }
    return { ...d, nodes, segments, rollback: [] };
  }
  draftAt(drag, pt, node) {
    const d = this.draft;
    if (!node) throw Error(drag.index < 0
      ? 'Release on the model to place a seam node.'
      : 'Release on the model to move a seam node.');
    if (drag.index >= 0 && Math.hypot(pt.x - drag.pt.x, pt.y - drag.pt.y) > 3) {
      return this.movedDraft(drag.index, node);
    }
    if (drag.moved) return d;
    const canClose = !d.closed && d.nodes.length >= 3;
    if (canClose && drag.index <= 0 && this.markerAt(pt, 3) === 0) {
      return this.extendedDraft(d.nodes[0], true);
    }
    if (drag.index >= 0 && this.markerAt(pt, 0.75) === drag.index) {
      throw Error('This spot already has a seam node. Drag it to move it.');
    }
    if (d.closed) throw Error('The loop is closed. Apply it, or press Backspace to reopen it.');
    return this.extendedDraft(node, false);
  }
  move(pt, event) {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.index >= 0 && Math.hypot(pt.x - drag.pt.x, pt.y - drag.pt.y) > 3) drag.moved = true;
    drag.latest = pt;
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0;
      if (this.drag !== drag) return;
      const point = drag.latest, node = this.nodeAt(point);
      let preview;
      try {
        preview = this.draftAt(drag, point, node);
      } catch {
        // An unprojectable path has no guide. Report the reason only on release.
      }
      this.redraw(preview, preview ? null : node);
    });
  }
  up(pt, event) {
    const drag = this.drag;
    if (!drag || (event.type !== 'blur' && event.pointerId !== drag.id)) return;
    this.drag = null;
    if (event.type === 'pointerup') {
      try {
        const next = this.draftAt(drag, pt, this.nodeAt(pt));
        if (next !== this.draft) {
          this.draft = next;
          this.updateGuide();
          return;
        }
      } catch (error) {
        this.notify(error.message);
      }
    }
    if (!this.draft.nodes.length) this.draft = null;
    this.redraw();
  }
  project(a, b) {
    return projectSegment(this.view.project, this.view.tree, this.view.camera, a, b);
  }
  changeSegments(change) {
    try {
      change();
      return true;
    } catch (error) {
      this.redraw();
      this.notify(error.message);
      return false;
    }
  }
  back() {
    if (!this.draft) return;
    if (this.drag) {
      this.drag = null;
      if (!this.draft.nodes.length) this.draft = null;
      this.redraw();
      return;
    }
    const d = this.draft;
    d.segments.pop();
    for (const [i, path] of d.rollback.pop() ?? []) d.segments[i] = path;
    d.runStart = Math.min(d.runStart, d.segments.length);
    if (d.closed) d.closed = false;
    else d.nodes.pop();
    if (!d.nodes.length) this.cancel();
    else this.updateGuide();
  }
  updateGuide() {
    const { nodes, segments, closed } = this.draft;
    let count = 0;
    this.result = segments.length
      ? {
          seam: {
            nodes,
            closed,
            ...(this.smooth.checked && { smooth: true }),
            edges: segments.flat(),
            segmentEnds: segments.map((s) => (count += s.length)),
          },
        }
      : null;
    this.redraw();
    this.notify(
      !this.result
        ? 'First node placed. Keep it visible when placing the next.'
        : closed
          ? 'Closed seam · Enter to apply.'
          : 'Open seam · ' +
            nodes.length +
            ' nodes · Click the first node to close, or Enter to apply as drawn.'
    );
  }
  finish() {
    if (this.drag || !this.result) return;
    const { seam } = this.result,
      index = this.draft.index,
      seams = [...(this.view.project.seams ?? [])];
    const at = index < 0 ? seams.length : index;
    seams[at] = seams[at]?.name ? { ...seam, name: seams[at].name } : seam;
    this.commit(index < 0 ? 'Added seam' : 'Edited seam', seams, at);
  }
}
