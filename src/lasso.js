// Convert a centripetal Catmull–Rom spline to cubic Béziers. Weighting the
// tangent by the spacing on each side keeps short spans beside long ones tame.
export function lassoCubics(points, closed) {
  const spans = [], tangents = [], segments = [];
  const n = points.length, count = closed ? n : n - 1;
  if (n < 2) return segments;
  for (let i = 0; i < count; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const dt = Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y));
    spans.push({dt, x: (b.x - a.x) / dt, y: (b.y - a.y) / dt});
  }
  for (let i = 0; i < n; i++) {
    const prev = i === 0 && closed ? spans.at(-1) : spans[i - 1];
    const next = spans[i];
    if (!prev || !next) {
      tangents.push(prev ?? next);
      continue;
    }
    const weight = next.dt / (prev.dt + next.dt);
    tangents.push({x: weight * prev.x + (1 - weight) * next.x,
      y: weight * prev.y + (1 - weight) * next.y});
  }
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n, a = points[i], b = points[j], scale = spans[i].dt / 3;
    segments.push([a, {x:a.x + tangents[i].x * scale, y:a.y + tangents[i].y * scale},
      {x:b.x - tangents[j].x * scale, y:b.y - tangents[j].y * scale}, b]);
  }
  return segments;
}

export function lassoSegments(points, closed) {
  return lassoCubics(points, closed).map(([,a,b,end]) =>
    ['C', a.x, a.y, b.x, b.y, end.x, end.y].join(' '));
}

// Rasterize the closed screen-space loop once. The summed mask lets the
// edge refiner recognize solid interiors and concave boundaries at any scale.
export function lassoFootprint(path, bounds, viewWidth, viewHeight, slot) {
  const xmin = Math.max(0, Math.floor(bounds.x)), ymin = Math.max(0, Math.floor(bounds.y));
  const xmax = Math.min(viewWidth, Math.ceil(bounds.x + bounds.width));
  const ymax = Math.min(viewHeight, Math.ceil(bounds.y + bounds.height));
  const w = xmax - xmin, h = ymax - ymin;
  if (w <= 0 || h <= 0) return null;
  const ctx = new OffscreenCanvas(w, h).getContext('2d');
  ctx.translate(-xmin, -ymin);
  ctx.fill(new Path2D(path), 'evenodd');
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const stride = w + 1, sums = new Uint32Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] >= 128) row++;
      const i = (y + 1) * stride + x + 1;
      sums[i] = sums[i - stride] + row;
    }
  }
  if (!sums.at(-1)) return null;
  const count = (l, t, r, b) => sums[b * stride + r] - sums[b * stride + l]
    - sums[t * stride + r] + sums[t * stride + l];
  return {
    xmin, xmax, ymin, ymax,
    sample(p) {
      const x = Math.floor(p.x) - xmin, y = Math.floor(p.y) - ymin;
      return x >= 0 && x < w && y >= 0 && y < h && count(x, y, x + 1, y + 1) ? slot : 255;
    },
    classify(tri) {
      const xs = tri.map(p => Math.floor(p.x) - xmin), ys = tri.map(p => Math.floor(p.y) - ymin);
      const l = Math.min(...xs), r = Math.max(...xs) + 1, t = Math.min(...ys), b = Math.max(...ys) + 1;
      if (r <= 0 || b <= 0 || l >= w || t >= h) return 255;
      const hit = count(Math.max(0, l), Math.max(0, t), Math.min(w, r), Math.min(h, b));
      if (!hit) return 255;
      return hit === (r - l) * (b - t) ? slot : -1;
    },
  };
}
