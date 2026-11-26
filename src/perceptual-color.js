import { srgbToLinear } from './vendor/prusa-fdm-mixer/color.js';

const linear = Float64Array.from({ length: 256 }, (_, byte) => srgbToLinear(byte));
export const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

// Linear sRGB to Oklab, D65. See CSS Color 4, "Color conversion code".
export function oklab(red, green, blue) {
  const r = linear[red], g = linear[green], b = linear[blue];
  const l = Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b);
  const m = Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b);
  const s = Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
  return [
    0.2104542553*l + 0.793617785*m - 0.0040720468*s,
    1.9779984951*l - 2.428592205*m + 0.4505937099*s,
    0.0259040371*l + 0.7827717662*m - 0.808675766*s,
  ];
}
export const swatchLab = hex => oklab(...rgb(hex));
export const distanceSquared = (a, b) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// Exact nearest-neighbor search for the thousands of possible recipes in a stamp import.
export function colorIndex(entries, depth = 0) {
  if (!entries.length) return null;
  const axis = depth % 3;
  entries.sort((a, b) => a.lab[axis] - b.lab[axis]);
  const mid = entries.length >> 1;
  return { entry: entries[mid], axis, left: colorIndex(entries.slice(0, mid), depth + 1),
    right: colorIndex(entries.slice(mid + 1), depth + 1) };
}

export function closestColor(point, tree) {
  let slot = -1, best = Infinity;
  function visit(node) {
    if (!node) return;
    const { entry, axis, left, right } = node;
    const error = distanceSquared(point, entry.lab);
    if (error < best || (error === best && entry.slot < slot)) {
      best = error;
      slot = entry.slot;
    }
    const gap = point[axis] - entry.lab[axis];
    visit(gap < 0 ? left : right);
    if (gap * gap <= best) visit(gap < 0 ? right : left);
  }
  visit(tree);
  return { slot, error: Math.sqrt(best) };
}
