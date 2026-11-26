import { rgb, swatchLab, oklab, distanceSquared, colorIndex, closestColor } from './perceptual-color.js';

// A screen-space allowance in Oklab units. Physical print accuracy depends on the spools.
const MATCH_TOLERANCE = 0.02;
function imageHistogram(data, minAlpha, collect) {
  const histogram = new Map();
  let hasInk = false;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) continue;
    hasInk = true;
    if (!collect || alpha < minAlpha) continue;
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
  return histogram;
}

function searchTrees(palette, mixes, candidates) {
  const colors = palette.map(swatchLab);
  const entries = colors.map((lab, slot) => ({ lab, slot }));
  const solids = colorIndex(entries.filter(e => !mixes?.[e.slot]));
  const savedMixes = colorIndex(entries.filter(e => mixes?.[e.slot]));
  const candidateTree = colorIndex((candidates ?? []).map(({ hex }, slot) => ({ lab: swatchLab(hex), slot })));
  return { solids, savedMixes, candidateTree };
}

function matchedBins(histogram, candidates, { solids, savedMixes, candidateTree }) {
  return [...histogram.values()].map(bin => {
    const channels = bin.slice(0, 3).map(sum => Math.round(sum / bin[3]));
    const lab = oklab(...channels);
    const hex = '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase();
    const match = candidates ? closestColor(lab, candidateTree) : { error: 0 };
    const error = Math.min(closestColor(lab, solids).error, closestColor(lab, savedMixes).error);
    return { lab, weight: bin[3], hex: candidates ? candidates[match.slot]?.hex : hex,
      recipe: candidates?.[match.slot]?.parts, targetError: match.error, error };
  });
}

export function mapImage(data, palette, limit = 0, opacityPercent = 0, options = {}) {
  const minAlpha = Math.max(1, Math.ceil((255 * opacityPercent) / 100));
  const { candidates } = options;
  // An import session owns one image and one palette. Only opacity and mode change.
  const session = options.session ?? {};
  const treesByMode = session.trees ??= new Map();
  if (!treesByMode.has(candidates)) treesByMode.set(candidates, searchTrees(palette, options.mixes, candidates));
  const trees = treesByMode.get(candidates);
  const { solids, savedMixes } = trees;
  if (session.minAlpha !== minAlpha || session.collect !== !!limit) {
    session.histogram = imageHistogram(data, minAlpha, !!limit);
    session.minAlpha = minAlpha;
    session.collect = !!limit;
    session.matches = new Map();
  }
  if (!session.matches.has(candidates)) {
    session.matches.set(candidates, matchedBins(session.histogram, candidates, trees));
  }
  const bins = session.matches.get(candidates).map(bin => ({ ...bin }));
  const added = [], recipes = [], colors = palette.map(swatchLab);
  for (let i = 0; i < Math.min(limit, options.capacity ?? 16 - palette.length); i++) {
    // Combine the improvement for image regions that want the same new swatch.
    const gains = new Map();
    let best, bestGain = 0;
    for (const bin of bins) {
      const gain = bin.error - bin.targetError;
      if (!bin.hex || gain <= MATCH_TOLERANCE) continue;
      const total = (gains.get(bin.hex) ?? 0) + gain * bin.weight;
      gains.set(bin.hex, total);
      if (total > bestGain) { best = bin; bestGain = total; }
    }
    if (!best) break;
    const lab = swatchLab(best.hex);
    added.push(best.hex);
    colors.push(lab);
    if (candidates) recipes.push(best.recipe);
    for (const bin of bins) bin.error = Math.min(bin.error, Math.sqrt(distanceSquared(bin.lab, lab)));
  }
  const newColors = colorIndex(colors.slice(palette.length).map((lab, i) => ({ lab, slot: palette.length + i })));
  const pixels = new Uint8Array(data.length / 4).fill(255);
  const cache = new Map();
  const used = new Set();
  for (let i = 0; i < pixels.length; i++) {
    const k = i * 4;
    if (data[k + 3] < minAlpha) continue;
    const r = data[k], g = data[k + 1], b = data[k + 2];
    const key = (r << 16) | (g << 8) | b;
    let slot = cache.get(key);
    if (slot === undefined) {
      const lab = oklab(r, g, b);
      const solid = closestColor(lab, solids), mix = closestColor(lab, savedMixes), fresh = closestColor(lab, newColors);
      const cutoff = Math.min(solid.error, mix.error, fresh.error) + MATCH_TOLERANCE;
      slot = solid.error <= cutoff ? solid.slot : mix.error <= cutoff ? mix.slot : fresh.slot;
      cache.set(key, slot);
    }
    pixels[i] = slot;
    used.add(slot);
  }
  // The final pixel pass uses exact colors. A histogram candidate can be
  // superseded by a later addition or lose a close match to an existing spool.
  const keep = added.map((_, i) => used.has(palette.length + i));
  if (keep.includes(false)) {
    let next = palette.length;
    const indices = keep.map(retain => retain ? next++ : 255);
    for (let i = 0; i < pixels.length; i++)
      if (pixels[i] !== 255 && pixels[i] >= palette.length) pixels[i] = indices[pixels[i] - palette.length];
  }
  return { pixels, added: added.filter((_, i) => keep[i]),
    ...(candidates && { recipes: recipes.filter((_, i) => keep[i]) }) };
}
export function stampCanvas(stamp, palette, showRemoved = false, maxSize = Infinity) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, maxSize / Math.max(stamp.width, stamp.height));
  const width = canvas.width = Math.max(1, Math.round(stamp.width * scale));
  const height = canvas.height = Math.max(1, Math.round(stamp.height * scale));
  const ctx = canvas.getContext('2d'), image = ctx.createImageData(width, height), colors = palette.map(rgb);
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y + 0.5) * stamp.height / height) * stamp.width;
    for (let x = 0; x < width; x++) {
      const source = row + Math.floor((x + 0.5) * stamp.width / width);
      const slot = stamp.pixels[source], dest = (y * width + x) * 4;
      if (slot !== 255) {
        image.data.set(colors[slot], dest);
        image.data[dest + 3] = 255;
      } else if (showRemoved && stamp.data[source * 4 + 3]) image.data.set([208, 43, 134, 255], dest);
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
export async function loadArtwork(file) {
  if (file.size > 32 * 1024 * 1024) throw Error('Choose an image smaller than 32 MB.');
  const bmp = await createImageBitmap(file);
  try {
    if (bmp.width * bmp.height > 16000000) throw Error('Choose artwork under 16 megapixels.');
    const canvas = document.createElement('canvas');
    const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    let source;
    if (signature.length === 8 && [137,80,78,71,13,10,26,10].every((byte, i) => signature[i] === byte)) {
      source = new Uint8Array(await file.arrayBuffer());
    } else {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      source = new Uint8Array(await png.arrayBuffer());
    }
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
