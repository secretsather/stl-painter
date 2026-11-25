const summaries = new WeakMap();

// A thin line or transparent hole can lie entirely between the three
// vertices. Test all covered texels without scanning the image for each leaf.
function imageSums({ pixels, width, height }) {
  if (summaries.has(pixels)) return summaries.get(pixels);
  const stride = width + 1;
  const sum = new Uint32Array(stride * (height + 1));
  const squares = new Float64Array(sum.length);
  for (let y = 0; y < height; y++) {
    let row = 0,
      rowSquares = 0;
    for (let x = 0; x < width; x++) {
      const value = pixels[y * width + x],
        i = (y + 1) * stride + x + 1;
      row += value;
      rowSquares += value * value;
      sum[i] = sum[i - stride] + row;
      squares[i] = squares[i - stride] + rowSquares;
    }
  }
  const result = { sum, squares, stride };
  summaries.set(pixels, result);
  return result;
}

function fitCenter(center, radius, span) {
  const inset = Math.min(radius, span / 2);
  return Math.max(inset, Math.min(center, span - inset));
}

export function stampFootprint(stamp, placement) {
  const { width, height, pixels } = stamp;
  const { rotation, workspace } = placement;
  const scale = placement.width / width;
  const angle = (rotation * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  const rx = (scale * (Math.abs(cos) * width + Math.abs(sin) * height)) / 2;
  const ry = (scale * (Math.abs(sin) * width + Math.abs(cos) * height)) / 2;
  const x = workspace ? fitCenter(placement.x, rx, workspace.width) : placement.x;
  const y = workspace ? fitCenter(placement.y, ry, workspace.height) : placement.y;
  const u = (p) => Math.floor(((p.x - x) * cos + (p.y - y) * sin) / scale + width / 2);
  const v = (p) => Math.floor(((p.y - y) * cos - (p.x - x) * sin) / scale + height / 2);
  return {
    center: { x, y },
    xmin: x - rx,
    xmax: x + rx,
    ymin: y - ry,
    ymax: y + ry,
    sample(p) {
      const i = u(p),
        j = v(p);
      return i >= 0 && j >= 0 && i < width && j < height ? pixels[j * width + i] : 255;
    },
    classify(tri) {
      const us = tri.map(u),
        vs = tri.map(v);
      const left = Math.min(...us),
        right = Math.max(...us);
      const top = Math.min(...vs),
        bottom = Math.max(...vs);
      const x0 = Math.max(0, left),
        x1 = Math.min(width, right + 1);
      const y0 = Math.max(0, top),
        y1 = Math.min(height, bottom + 1);
      if (x1 <= x0 || y1 <= y0) return 255;
      const color = pixels[y0 * width + x0];
      if (color !== 255 && (left < 0 || top < 0 || right >= width || bottom >= height)) return -1;
      if (x1 - x0 === 1 && y1 - y0 === 1) return color;
      const { sum, squares, stride } = imageSums(stamp);
      const rect = (a) =>
        a[y1 * stride + x1] - a[y0 * stride + x1] - a[y1 * stride + x0] + a[y0 * stride + x0];
      // Sum of squared differences is zero exactly for a uniform rectangle.
      return rect(squares) - 2 * color * rect(sum) + (x1 - x0) * (y1 - y0) * color * color === 0
        ? color
        : -1;
    },
  };
}
