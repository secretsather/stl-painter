import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { newProject } from '../src/mesh.js';
import { exportFilaments, filamentMasks, mixCandidates, mixHex, suggestFilament, validRecipe } from '../src/mixes.js';
import { mapImage } from '../src/stamps.js';
import { readProject, writeProject, write3MF, paintTree } from '../src/files.js';
import { findColorConflict } from '../src/color-at-height.js';

const recipe = (...weights) => weights.map((percent, slot) => ({ slot, percent }));
const physical = [0, 1, 2, 3];
test('recipes require two or three distinct physical filaments, each at least 33%, totaling 100%', () => {
  for (const weights of [[33,67],[67,33],[50,50],[33,33,34],[33,34,33],[34,33,33]])
    assert.ok(validRecipe(recipe(...weights), physical));
  for (const weights of [[32,68],[34,67],[25,25,25,25],[33,33,33],[100]])
    assert.ok(!validRecipe(recipe(...weights), physical));
  assert.ok(!validRecipe([{slot:0,percent:50},{slot:0,percent:50}], physical));
  assert.ok(!validRecipe([{slot:0,percent:50},{slot:4,percent:50}], physical));
});

test('stamp matching can add an exact three-filament recipe without allocating a spool', () => {
  const palette = ['#FF0000','#00FF00','#0000FF'];
  const candidates = mixCandidates({ palette });
  const { pixels, added, recipes } = mapImage(Uint8Array.of(34,34,34,255,0,0,0,0), palette, 1, 50, { candidates });
  assert.deepEqual(added, ['#222222']);
  assert.deepEqual(recipes, [recipe(33,34,33)]);
  assert.deepEqual([...pixels], [3,255]);
  assert.deepEqual(mapImage(Uint8Array.of(255,0,0,255), palette, 1, 0, { candidates }).added, []);
});

test('calibrated swatches, near-match preferences and palette-aware spool suggestions', () => {
  const palette = ['#E7DDC8', '#FFFFFF', '#00C1AE', '#F4E2C1'];
  const cream = mixHex(palette, recipe(50,50));
  assert.equal(cream, '#F1E3C0');
  assert.equal(mixHex(['#DE7248','#386D67'], recipe(50,50)), '#776554');
  assert.equal(suggestFilament({palette}), '#242629');
  assert.equal(suggestFilament({palette:['#242629']}), '#F7F5EF');
  const artwork = Uint8Array.of(241,227,192,255);
  const existing = mapImage(artwork, [...palette, cream], 1, 0,
    {mixes:{4:recipe(50,50)}, candidates:mixCandidates({palette})});
  assert.equal(existing.pixels[0], 3, 'existing cream spool wins the close match with a saved mix');
  assert.deepEqual(existing.added, []);
  assert.deepEqual(mapImage(artwork, palette, 1, 0, {candidates:mixCandidates({palette})}).added, []);
  const saved = mapImage(artwork, [...palette.slice(0,2), cream], 1, 0,
    {mixes:{2:recipe(50,50)}, candidates:mixCandidates({palette})});
  assert.equal(saved.pixels[0], 2);
  assert.deepEqual(saved.added, []);
  assert.equal(mapImage(Uint8Array.of(32,224,64,255), ['#E7DDC8','#384956']).pixels[0], 0,
    'perceptual matching assigns bright green to the lighter of these two swatches');
});

test('legacy projects upgrade previews and selected swatch while retaining distinct printable recipes on collisions', () => {
  const p = newProject('Legacy',Float32Array.of(0,0,0,1,0,0,0,1,0), Uint32Array.of(0,1,2));
  for (const collides of [false,true]) {
    p.palette = ['#E7DDC8', '#FFFFFF', collides ? '#F1E3C0' : '#00C1AE', '#F3EEE4'];
    p.mixes = {3:recipe(50,50)};
    p.paint.fill(3);
    p.stamps = [{ name:'ink', width:2, height:1, source:Uint8Array.of(137,80), pixels:Uint8Array.of(3,255) }];
    p.editingContext = { color:'#F3EEE4' };
    const archive = unzipSync(writeProject(p));
    const manifest = JSON.parse(strFromU8(archive['project.json']));
    archive['project.json'] = strToU8(JSON.stringify({...manifest, version:3}));
    const migrated = readProject(zipSync(archive));
    assert.equal(migrated.palette[3], collides ? '#F3EEE4' : '#F1E3C0');
    assert.equal(migrated.editingContext.color, migrated.palette[3]);
    assert.deepEqual(migrated.paint,p.paint);
    assert.deepEqual(migrated.stamps,p.stamps);
    assert.deepEqual(migrated.mixes,p.mixes);
    assert.deepEqual(readProject(writeProject(migrated)), migrated);
    assert.deepEqual(exportFilaments(migrated),exportFilaments(p));
  }
});

test('mixed paint keeps recipes and source IDs through save, export and slice checks', () => {
  const p = newProject('Test',Float32Array.of(0,0,0,1,0,0,0,1,0), Uint32Array.of(0,1,2));
  const pair = recipe(67,33), triple = recipe(33,33,34);
  p.palette = ['#FF0000','#00FF00','#0000FF','#FFFFFF'];
  p.mixes = {4:pair,5:triple};
  p.palette.push(mixHex(p.palette,pair),mixHex(p.palette,triple));
  p.paint.fill(4);
  p.paint[0] = 5;
  assert.deepEqual(readProject(writeProject(p)),p);
  const invalid = {...p,mixes:{...p.mixes,4:recipe(32,68)}};
  assert.throws(()=>readProject(writeProject(invalid)),/damaged/);
  const files = unzipSync(write3MF(p));
  const settings = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
  assert.deepEqual(settings.filament_colour,p.palette.slice(0,4));
  const [a,b] = settings.mixed_filament_definitions.split(';');
  assert.match(a,/^1,2,1,1,33,0,g,w,m2,/);
  assert.match(b,/g1\/2\/3,w33\/33\/34,m0,/);
  assert.deepEqual(exportFilaments(p).slots,[1,2,3,4,5,6]);
  assert.match(strFromU8(files['3D/3dmodel.model']),/paint_color="[^"]*3C/);
  const heights = Float32Array.of(0,10,0,10);
  assert.equal(findColorConflict(heights, [4,5],3,filamentMasks(p)),null);
  assert.equal(findColorConflict(heights, [4,5],2,filamentMasks(p)).mask,7);
  assert.equal(paintTree([0,0,0,0],0,4,[18]),'0FC');
  assert.equal(paintTree([0],0,1,[33]),'0FFC');
});
