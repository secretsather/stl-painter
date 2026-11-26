import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteMapping, readPalette, writePalette } from '../src/palette-file.js';
import { mixHex } from '../src/mixes.js';

test('palette files round-trip interleaved filaments and pair and trio recipes', () => {
  const palette = ['#FFFFFF', '#DDAA33', '', '#2255AA', ''];
  const mixes = {
    2: [{ slot: 1, percent: 67 }, { slot: 3, percent: 33 }],
    4: [{ slot: 0, percent: 33 }, { slot: 1, percent: 33 }, { slot: 3, percent: 34 }],
  };
  for (const [slot, parts] of Object.entries(mixes)) palette[slot] = mixHex(palette, parts);
  const encoded = writePalette({ palette, mixes, name: 'Private model', stamps: [], paint: [0, 1] });
  assert.deepEqual(Object.keys(JSON.parse(encoded)).sort(), ['format', 'mixes', 'palette', 'version']);
  assert.deepEqual(readPalette('\uFEFF' + encoded), { palette, mixes });
  assert.deepEqual(readPalette(writePalette({ palette: ['#aabbcc'] })), { palette: ['#AABBCC'], mixes: {} });
});

test('invalid palette files, duplicate colors and invalid recipes are rejected', () => {
  for (const text of ['{', '{}', writePalette({palette:['#000000']}).replace('"version": 1', '"version": 2')]) {
    assert.throws(() => readPalette(text));
  }
  for (const palette of [[], ['red'], ['#ABCDEF', '#abcdef'],
    Array.from({ length: 17 }, (_, i) => '#' + i.toString(16).padStart(6, '0'))]) {
    assert.throws(() => readPalette(writePalette({ palette })));
  }
  const palette = ['#FFFFFF', '#000000', '#FFEEDD'];
  const invalidRecipes = [
    [0, [1, 2], [50, 50], 'mixed base'],
    [3, [0, 1], [50, 50], 'missing swatch'],
    [2, [0, 2], [50, 50], 'recursive mix'],
    [2, [0, 1], [32, 68], 'share below minimum'],
    [2, [0, 0], [50, 50], 'repeated filament'],
    [2, [0, 1], [50, 50], 'incorrect preview color'],
    [2, [0, 1], [49, 50], 'shares below 100 percent'],
  ];
  for (const [key, slots, shares, reason] of invalidRecipes) {
    const mixes = { [key]: slots.map((slot, i) => ({ slot, percent: shares[i] })) };
    assert.throws(() => readPalette(writePalette({ palette, mixes })), reason);
  }
});

test('palette replacement preserves the base and maps reordered and missing colors by appearance', () => {
  assert.deepEqual(paletteMapping(['#FFFF00', '#FF0000', '#0000EE', '#FFFF01'],
    ['#FFFFFF', '#0000FF', '#FFFF00', '#FF0000']), [0, 3, 1, 2]);
});
