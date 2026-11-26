import { MAX_FILAMENTS, MAX_SWATCHES, mixHex, physicalSlots, validRecipe } from './mixes.js';
import { closestColor, colorIndex, swatchLab } from './perceptual-color.js';

export const validColor = (s) => typeof s === 'string' && /^#[\da-f]{6}$/i.test(s);

// Version 3 stored an arithmetic sRGB preview. If a calibrated preview lands
// on an occupied hex, retain the old chip so both printable recipes survive.
function legacyMixHex(palette, parts) {
  const channels = [1, 3, 5].map(i => Math.round(parts.reduce((sum, part) =>
    sum + parseInt(palette[part.slot].slice(i, i + 2), 16) * part.percent, 0) / 100));
  return '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function validatedPalette(data, migrateLegacy = false) {
  const fail = () => { throw Error('The color palette contains invalid colors or mix recipes.'); };
  if (!Array.isArray(data?.palette) || !data.palette.length || data.palette.length > MAX_SWATCHES ||
      !data.palette.every(validColor) || !data.mixes || typeof data.mixes !== 'object' ||
      Array.isArray(data.mixes)) fail();
  const palette = data.palette.map(hex => hex.toUpperCase()), mixes = {};
  const occupied = new Set(palette), physical = physicalSlots(data);
  if (occupied.size !== palette.length || !physical.length || physical.length > MAX_FILAMENTS) fail();
  for (const [key, parts] of Object.entries(data.mixes)) {
    const slot = Number(key);
    if (!Number.isInteger(slot) || String(slot) !== key || slot < 1 || slot >= palette.length ||
        !validRecipe(parts, physical)) fail();
    mixes[slot] = parts.map(({ slot, percent }) => ({ slot, percent }));
    const stored = palette[slot], calibrated = mixHex(palette, parts);
    if (!migrateLegacy && stored === calibrated) continue;
    if (stored !== legacyMixHex(palette, parts)) fail();
    if (migrateLegacy && !occupied.has(calibrated)) {
      occupied.delete(stored);
      occupied.add(calibrated);
      palette[slot] = calibrated;
    }
  }
  return { palette, mixes };
}

const format = 'stl-painter-palette';

export function writePalette({ palette, mixes = {} }) {
  return JSON.stringify({ format, version: 1, palette, mixes }, null, 2) + '\n';
}

export function readPalette(text) {
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw Error('This file is not a readable STL Painter palette.'); }
  if (data?.format !== format) throw Error('Choose an STL Painter palette file.');
  if (data.version !== 1) throw Error('This palette requires a different version of STL Painter.');
  return validatedPalette(data);
}

export function paletteMapping(current, incoming) {
  const tree = colorIndex(incoming.map((hex, slot) => ({ lab: swatchLab(hex), slot })));
  return current.map((hex, i) => i === 0 ? 0 : closestColor(swatchLab(hex), tree).slot);
}
