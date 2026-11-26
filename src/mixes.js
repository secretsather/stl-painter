import { mixFilaments } from './vendor/prusa-fdm-mixer/prusa-fdm-mixer.js';
import { swatchLab, distanceSquared } from './perceptual-color.js';

// Paint and stamp pixels share byte-sized swatch indices. 255 marks transparency.
export const MAX_SWATCHES = 255;
export const MAX_FILAMENTS = 16;

export function physicalSlots(project) {
  return project.palette.map((_, slot) => slot).filter(slot => !project.mixes?.[slot]);
}

export function validRecipe(parts, physical) {
  return Array.isArray(parts) && [2, 3].includes(parts.length) &&
    parts.every(part => part && physical.includes(part.slot) &&
      Number.isInteger(part.percent) && part.percent >= 33) &&
    new Set(parts.map(part => part.slot)).size === parts.length &&
    parts.reduce((sum, part) => sum + part.percent, 0) === 100;
}

export function mixHex(palette, parts) {
  return mixFilaments(parts.map(({ slot, percent }) =>
    ({ hex: palette[slot], ratio: percent / 100 }))).hex.toUpperCase();
}

export function recipeLabel(parts, physical) {
  return parts.map(({ slot, percent }) => `Color ${physical.indexOf(slot) + 1} · ${percent}%`).join(' + ');
}

export function* filamentGroups(physical) {
  for (let a = 0; a < physical.length; a++) {
    for (let b = a + 1; b < physical.length; b++) {
      const pair = [physical[a], physical[b]];
      yield pair;
      for (let c = b + 1; c < physical.length; c++) yield [...pair, physical[c]];
    }
  }
}

export function mixCandidates(project) {
  const physical = physicalSlots(project), seen = new Set(project.palette), result = [];
  for (const parts of Object.values(project.mixes ?? {})) seen.add(mixHex(project.palette, parts));
  function add(slots, weights) {
    const parts = slots.map((slot, i) => ({ slot, percent: weights[i] }));
    const hex = mixHex(project.palette, parts);
    if (!seen.has(hex)) {
      seen.add(hex);
      result.push({ hex, parts });
    }
  }
  for (const slots of filamentGroups(physical)) {
    if (slots.length === 2) {
      for (let ratio = 33; ratio <= 67; ratio++) add(slots, [ratio, 100 - ratio]);
    } else {
      for (let extra = 0; extra < 3; extra++) add(slots, slots.map((_, i) => i === extra ? 34 : 33));
    }
  }
  return result;
}

const suggestedColors = [
  '#7995AD', '#E5B44C', '#875C93', '#76944F', '#AD4159', '#F7F5EF', '#242629', '#2768A3',
  '#D890AD', '#805538', '#6CC4BF', '#B3A2D9', '#E46831', '#A9CDE5', '#566C38', '#94765F',
];

export function suggestFilament(project) {
  const taken = new Set(project.palette);
  const choices = suggestedColors.filter(hex => !taken.has(hex));
  if (!choices.length) {
    // Saved mixes can already occupy every named suggestion. Offer a distinct
    // shade from a wider grid (512 colors, more than the total swatch limit).
    const bytes = Array.from({length: 8}, (_, i) => Math.round(i * 255 / 7).toString(16).padStart(2, '0'));
    for (const r of bytes) for (const g of bytes) for (const b of bytes) {
      const hex = ('#' + r + g + b).toUpperCase();
      if (!taken.has(hex)) choices.push(hex);
    }
  }
  const gamut = [...project.palette, ...mixCandidates(project).map(c => c.hex)].map(swatchLab);
  let best = choices[0], separation = -1;
  for (const hex of choices) {
    const lab = swatchLab(hex);
    let nearest = Infinity;
    for (const existing of gamut) {
      nearest = Math.min(nearest, distanceSquared(lab, existing));
      if (nearest <= separation) break;
    }
    if (nearest > separation) { best = hex; separation = nearest; }
  }
  return best;
}

export function filamentMasks(project) {
  const physical = physicalSlots(project);
  const bit = slot => 1 << physical.indexOf(slot);
  return project.palette.map((_, slot) => project.mixes?.[slot]
    ? project.mixes[slot].reduce((mask, part) => mask | bit(part.slot), 0) : bit(slot));
}

export function exportFilaments(project) {
  const used = new Set(project.paint);
  const blends = Object.keys(project.mixes ?? {}).map(Number).filter(slot => used.has(slot));
  // Virtual IDs follow the physical spool list. Keep that list in printer
  // order even when a spool has no directly painted face.
  const physical = physicalSlots(project).filter(slot => blends.length || used.has(slot));
  const exported = [...physical, ...blends];
  const definitions = blends.map((slot, i) => {
    const parts = project.mixes[slot];
    const ids = parts.map(part => physical.indexOf(part.slot) + 1);
    const triple = ids.length === 3;
    const group = triple ? ids.join('/') : '';
    const weights = triple ? parts.map(part => part.percent).join('/') : '';
    return [ids[0], ids[1], 1, 1, parts[1].percent, 0, 'g' + group, 'w' + weights,
      triple ? 'm0' : 'm2', 'z0', 'xa0', 'xb0', 'd0', 'o0', 'u' + (i + 1), 'cm0'].join(',');
  });
  return { colors: physical.map(i => project.palette[i].toUpperCase()),
    slots: project.palette.map((_, i) => exported.indexOf(i) + 1), definitions: definitions.join(';') };
}
