const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function distance(a, b) {
  return 0.3 * (a[0] - b[0]) ** 2 + 0.59 * (a[1] - b[1]) ** 2 + 0.11 * (a[2] - b[2]) ** 2;
}
function nearest(point, colors) {
  let best = 0,
    score = Infinity;
  colors.forEach((c, i) => {
    const d = distance(point, c);
    if (d < score) {
      best = i;
      score = d;
    }
  });
  return [best, score];
}
export function mapImage(data, palette, limit = 0, opacityPercent = 0) {
  const minAlpha = Math.max(1, Math.ceil((255 * opacityPercent) / 100));
  const histogram = new Map(),
    colors = palette.map(rgb),
    added = [];
  let hasInk = false;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) continue;
    hasInk = true;
    if (alpha < minAlpha) continue;
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    let bin = histogram.get(key);
    if (!bin) {
      bin = [0, 0, 0, 0];
      histogram.set(key, bin);
    }
    for (let k = 0; k < 3; k++) bin[k] += data[i + k];
    bin[3]++;
  }
  if (!hasInk) throw Error('The image is fully transparent.');
  const bins = [...histogram.values()].map((b) => ({
    rgb: b.slice(0, 3).map((v) => Math.round(v / b[3])),
    weight: b[3],
  }));
  for (let i = 0; i < Math.min(limit, 16 - palette.length); i++) {
    let score = 0,
      pick = null;
    for (const b of bins) {
      const d = nearest(b.rgb, colors)[1];
      if (d > 9 && d * b.weight > score) {
        score = d * b.weight;
        pick = b.rgb;
      }
    }
    if (!pick) break;
    colors.push(pick);
    added.push(
      '#' +
        pick
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase()
    );
  }
  const pixels = new Uint8Array(data.length / 4);
  for (let i = 0; i < pixels.length; i++) {
    const k = i * 4;
    pixels[i] =
      data[k + 3] >= minAlpha ? nearest([data[k], data[k + 1], data[k + 2]], colors)[0] : 255;
  }
  return { pixels, added };
}
export function stampCanvas(stamp, palette, showRemoved = false) {
  const canvas = document.createElement('canvas');
  canvas.width = stamp.width;
  canvas.height = stamp.height;
  const ctx = canvas.getContext('2d'),
    image = ctx.createImageData(canvas.width, canvas.height),
    colors = palette.map(rgb);
  stamp.pixels.forEach((c, i) => {
    if (c !== 255) {
      image.data.set(colors[c], i * 4);
      image.data[i * 4 + 3] = 255;
    } else if (showRemoved && stamp.data[i * 4 + 3] > 0) {
      image.data.set([208, 43, 134, 255], i * 4);
    }
  });
  ctx.putImageData(image, 0, 0);
  return canvas;
}
export async function loadArtwork(file) {
  if (file.size > 32 * 1024 * 1024) throw Error('Choose an image smaller than 32 MB.');
  const bmp = await createImageBitmap(file);
  try {
    if (bmp.width * bmp.height > 16000000) throw Error('Choose artwork under 16 megapixels.');
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const source = new Uint8Array(await png.arrayBuffer());
    const ratio = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    canvas.width = Math.max(1, Math.round(bmp.width * ratio));
    canvas.height = Math.max(1, Math.round(bmp.height * ratio));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return {
      name: file.name,
      width: canvas.width,
      height: canvas.height,
      source,
      data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    };
  } finally {
    bmp.close();
  }
}
