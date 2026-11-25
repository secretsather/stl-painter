import {
  createIcons,
  FolderOpen,
  Save,
  Ellipsis,
  Box,
  Paintbrush,
  PaintBucket,
  Eraser,
  Stamp,
  Type,
  Undo2,
  Redo2,
  CircleHelp,
  TriangleAlert,
  ImagePlus,
  Orbit,
  Plus,
  Scan,
  Check,
  X,
} from 'lucide';
import { Viewport } from './viewport.js';
import { setupSidebar } from './sidebar.js';
import { setupImportPreview } from './import-preview.js';
import { RefinedStroke } from './refined-stroke.js';
import { applyLeafEdits } from './paint-tree.js';
import { readSTL, sampleProject, flood, binarySTLFaceCount, checkFaceLimit, LARGE_MODEL_FACES } from './mesh.js';
import { readProject, writeProject, writeOrca } from './files.js';
import { textArtwork, loadFontFamilies } from './text-artwork.js';
import { setupColorLimit } from './color-limit.js';
import { mapImage, stampCanvas, loadArtwork } from './stamps.js';

const $ = (id) => document.getElementById(id),
  all = (q) => [...document.querySelectorAll(q)];
const icons = {
  FolderOpen,
  Save,
  Ellipsis,
  Box,
  Paintbrush,
  PaintBucket,
  Eraser,
  Stamp,
  Type,
  Undo2,
  Redo2,
  CircleHelp,
  TriangleAlert,
  ImagePlus,
  Orbit,
  Plus,
  Scan,
  Check,
  X,
};
createIcons({ icons });
setupSidebar($('sidebar-divider'));
const importPreview = setupImportPreview($('mapping-preview'), $('fit-artwork'));
const files = window.painterFiles;
let p,
  v,
  tool = 'Brush',
  selected = 1,
  stampIndex = -1,
  anchor = null,
  armed = false,
  draggingArtwork = false,
  preview = new Map(),
  refinedPreview = null,
  previewFrame = 0;
let history = [],
  future = [],
  revision = 0,
  saved = 0,
  sequence = 0,
  stroke = null,
  busy = false,
  art = null,
  conversion = null;
const refreshColorLimit = setupColorLimit(() => ({
  paint: p.paint,
  palette: p.palette,
  positions: v.surface.positions,
  bottom: v.box.min[2],
}));
function notify(msg) {
  $('status').textContent = msg;
}
function error(err) {
  $('notice-text').textContent = String(err.message || err).replace(
    /^Error invoking remote method '[^']+': Error: /,
    ''
  );
  if (!$('notice').open) $('notice').showModal();
}
function state() {
  const pendingStroke = !!stroke?.old.size || !!stroke?.refiner?.edits.size;
  const changed = revision !== saved || pendingStroke;
  $('dirty').hidden = !changed;
  document.title = (changed ? '• ' : '') + p.name + ' — STL Painter';
  files.dirty(changed);
  $('undo').disabled = !history.length && !pendingStroke;
  $('redo').disabled = !future.length;
}
function record(label, change, weight = 0) {
  const before = revision;
  revision = ++sequence;
  history.push({ label, change, before, after: revision, weight });
  future = [];
  let size = history.reduce((sum, h) => sum + h.weight, 0);
  while (history.length > 1 && (size > 48000000 || history.length > 80))
    size -= history.shift().weight;
  state();
  notify(label);
  refreshColorLimit();
}
let textKey, textMask, fontList;
function placingArtwork() {
  return tool === 'Stamps' || tool === 'Text';
}
function currentArtwork() {
  if (tool === 'Stamps') return p.stamps[stampIndex];
  if (tool !== 'Text') return null;
  const settings = {
    text: $('text-content').value,
    family: $('text-font').value,
    size: +$('text-size').value,
    bold: $('text-bold').checked,
    italic: $('text-italic').checked,
    align: $('text-align').value,
    color: selected,
  };
  const key = JSON.stringify(settings);
  if (key !== textKey) {
    textMask = textArtwork(settings);
    textKey = key;
  }
  return textMask;
}
function armPreview() {
  armed = true;
  schedulePreview();
}
function hasPreview() {
  return !!(refinedPreview?.edits.size || preview.size);
}
function clearPreview() {
  $('stamp-outline').hidden = true;
  if (refinedPreview) {
    v.clearPaintPreview();
    refinedPreview.dispose();
    refinedPreview = null;
  }
  for (const id of preview.keys()) v.color(id, p.paint[id]);
  if (preview.size) v.recolor();
  preview.clear();
}
function updatePreview() {
  cancelAnimationFrame(previewFrame);
  previewFrame = 0;
  clearPreview();
  const artwork = armed && currentArtwork();
  if (!artwork) {
    $('apply').disabled = true;
    return;
  }
  anchor ??= { x: v.w / 2, y: v.h / 2 };
  const placement = {
    ...anchor,
    width: artwork.placementWidth ?? +$('stamp-size').value,
    rotation: +$('rotation').value,
    workspace: tool === 'Stamps' ? { width: v.w, height: v.h } : undefined,
    filter: $('filter').checked,
    cutoff: +$('cutoff').value,
  };
  const footprint = v.stampFootprint(artwork, placement);
  if (tool === 'Stamps') {
    anchor = footprint.center;
    const outline = $('stamp-outline');
    outline.style.left = anchor.x + 'px';
    outline.style.top = anchor.y + 'px';
    outline.style.width = placement.width + 'px';
    outline.style.height = (placement.width * artwork.height / artwork.width) + 'px';
    outline.style.transform = `translate(-50%, -50%) rotate(${placement.rotation}deg)`;
    outline.hidden = false;
  }
  if (!draggingArtwork && $('refine-stamp').checked) {
    refinedPreview = new RefinedStroke(v);
    refinedPreview.projectFootprint(footprint);
    if (refinedPreview.edits.size) v.previewPaint(refinedPreview.edits);
  } else {
    preview = draggingArtwork ? v.dragStamp(footprint) : v.stamp(footprint);
    for (const [id, color] of preview) v.color(id, color);
    if (preview.size) v.recolor();
  }
  $('apply').disabled = draggingArtwork || !hasPreview();
}
function schedulePreview() {
  if (!v || !p || !placingArtwork() || !armed || previewFrame) return;
  previewFrame = requestAnimationFrame(updatePreview);
}
function setColor(id, c) {
  if (p.paint[id] === c) return;
  if (!stroke.old.has(id)) stroke.old.set(id, p.paint[id]);
  p.paint[id] = c;
  v.color(id, c);
}
function finishStroke() {
  if (!stroke) return;
  if (stroke.refiner) {
    const { refiner } = stroke;
    if (refiner.limited) stroke.label += ' (detail limit reached)';
    refiner.dispose();
    const edits = refiner.edits;
    if ([...edits.values()].some((tree) => typeof tree !== 'number')) {
      const before = { paint: p.paint, splits: p.splits };
      const after = applyLeafEdits(p, edits);
      const change = (forward) => {
        const state = forward ? after : before;
        p.paint = state.paint;
        p.splits = state.splits;
        v.rebuildSurface();
      };
      const label = stroke.label;
      stroke = null;
      change(true);
      record(
        label,
        change,
        before.paint.length +
          (before.splits?.length ?? 0) +
          after.paint.length +
          after.splits.length
      );
      return;
    }
    for (const [id, color] of edits) setColor(id, color);
    v.recolor();
  }
  const { old, label } = stroke;
  stroke = null;
  if (!old.size) return;
  const ids = Uint32Array.from(old.keys()),
    before = Uint8Array.from(old.values()),
    after = idsToColors(ids);
  record(
    label,
    (forward) => {
      const colors = forward ? after : before;
      ids.forEach((id, i) => {
        p.paint[id] = colors[i];
        v.color(id, colors[i]);
      });
      v.recolor();
    },
    ids.byteLength + before.byteLength + after.byteLength
  );
}
function idsToColors(ids) {
  return Uint8Array.from(ids, (id) => p.paint[id]);
}
function undo(redo = false) {
  finishStroke();
  const from = redo ? future : history,
    to = redo ? history : future;
  if (!from.length) return;
  draggingArtwork = false;
  clearPreview();
  armed = false;
  const h = from.pop();
  h.change(redo);
  revision = redo ? h.after : h.before;
  to.push(h);
  selected = Math.min(selected, p.palette.length - 1);
  stampIndex = Math.min(stampIndex, p.stamps.length - 1);
  paletteUI();
  stampUI();
  toolUI();
  state();
  notify((redo ? 'Redid ' : 'Undid ') + h.label.toLowerCase());
  refreshColorLimit();
}
function removeButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'remove-entry';
  button.textContent = '×';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.onclick = action;
  return button;
}
function paletteUI() {
  const list = $('palette');
  list.replaceChildren();
  p.palette.forEach((hex, i) => {
    const row = document.createElement('div');
    row.className = 'swatch-row';
    const name = 'Color ' + (i + 1);
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'palette-picker';
    picker.value = hex;
    picker.title = 'Edit ' + name;
    picker.setAttribute('aria-label', picker.title);
    const b = document.createElement('button');
    b.setAttribute('aria-label', name + (i === 0 ? ' (base)' : ''));
    b.setAttribute('aria-pressed', String(i === selected));
    const code = document.createElement('span');
    code.className = 'palette-hex';
    code.textContent = hex.toUpperCase();
    b.append(code, document.createTextNode(name));
    if (i === 0) {
      const tag = document.createElement('span');
      tag.className = 'base';
      tag.textContent = 'Base';
      b.append(tag);
    }
    const icon = document.createElement('i');
    icon.dataset.lucide = 'check';
    b.append(icon);
    b.onclick = picker.onclick = () => {
      list.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
      selected = i;
      if (tool === 'Text') armPreview();
      b.setAttribute('aria-pressed', 'true');
    };
    picker.onchange = () => {
      const next = picker.value.toUpperCase();
      editPaletteColor(i, next);
      code.textContent = next;
    };
    row.append(picker, b);
    if (p.palette.length > 1) row.append(removeButton('Remove ' + name, () => requestColorRemoval(i)));
    list.append(row);
  });
  createIcons({ icons: { Check }, root: list });
  $('add-color').disabled = p.palette.length >= 16;
}
function stampUI() {
  const list = $('stamp-list');
  list.replaceChildren();
  p.stamps.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'stamp-choice';
    b.setAttribute('aria-pressed', String(i === stampIndex));
    const name = document.createElement('span');
    name.textContent = s.name;
    b.append(stampCanvas(s, p.palette), name);
    b.onclick = () => {
      clearPreview();
      stampIndex = i;
      armed = true;
      stampUI();
      updatePreview();
    };
    const row = document.createElement('div');
    row.className = 'stamp-row';
    row.append(b, removeButton('Remove stamp ' + s.name, () => removeStamp(i)));
    list.append(row);
  });
  updatePlacementVisibility();
}
function removeStamp(index) {
  const stamp = p.stamps[index];
  if (index === stampIndex) {
    draggingArtwork = armed = false;
    anchor = null;
    clearPreview();
    $('apply').disabled = true;
  }
  const change = (forward) => {
    const activeStamp = p.stamps[stampIndex];
    if (forward) p.stamps.splice(index, 1);
    else p.stamps.splice(index, 0, stamp);
    stampIndex = p.stamps.indexOf(activeStamp);
  };
  change(true);
  record('Removed stamp ' + stamp.name, change, stamp.source.byteLength + stamp.pixels.byteLength);
  stampUI();
  const choices = $('stamp-list').querySelectorAll('.stamp-choice');
  (choices[Math.min(index, choices.length - 1)] ?? $('import-image')).focus({ preventScroll: true });
}
function updatePlacementVisibility() {
  $('placement').hidden = tool !== 'Text' && !(tool === 'Stamps' && stampIndex >= 0);
  if (tool === 'Stamps') {
    $('tool-hint').textContent = stampIndex >= 0 ? hints.Stamps : 'Import artwork or select a stamp to place it.';
  }
}
const hints = {
  Brush: 'Drag across the visible surface to paint.',
  Fill: 'Click a region to fill across connected edges.',
  Eraser: 'Drag to expose the current base color.',
  Text: 'Click or drag to position your text. Press Esc to cancel and return to Brush.',
  Stamps: 'Click or drag to position the stamp. Press Esc to cancel and return to Brush.',
};
function toolUI() {
  $('tool-title').textContent = tool;
  $('tool-key').textContent = tool[0];
  $('tool-hint').textContent = hints[tool];
  for (const b of all('[data-tool]'))
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  $('brush-panel').hidden = !['Brush', 'Eraser'].includes(tool);
  $('fill-panel').hidden = tool !== 'Fill';
  $('stamp-panel').hidden = tool !== 'Stamps';
  const text = tool === 'Text';
  $('text-panel').hidden = !text;
  $('stamp-width').hidden = text;
  updatePlacementVisibility();
  $('refine-label').textContent = text ? 'Refine text edges' : 'Refine stamp edges';
  $('apply-label').textContent = text ? 'Apply text' : 'Apply stamp';
  $('refine-stamp').checked =
    localStorage.getItem(text ? 'refineTextEdges' : 'refineStampEdges') !== 'off';
  $('pointer').hidden = true;
  $('apply').disabled = !hasPreview();
}
function chooseTool(name) {
  draggingArtwork = false;
  finishStroke();
  clearPreview();
  tool = name;
  armed = tool === 'Text';
  if (tool === 'Stamps') {
    stampIndex = -1;
    anchor = null;
    stampUI();
  }
  if (tool === 'Text') {
    fontList ??= loadFontFamilies($('text-font')).then(schedulePreview);
  }
  toolUI();
  if (tool === 'Text') $('text-content').focus();
  schedulePreview();
}
function load(project, kind) {
  draggingArtwork = false;
  if (v?.project) clearPreview();
  p = project;
  history = [];
  future = [];
  revision = saved = 0;
  stroke = null;
  anchor = null;
  selected = Math.min(kind === 'SAMPLE MODEL' ? 2 : 1, p.palette.length - 1);
  refineEdges.checked = true;
  stampIndex = -1;
  tool = 'Brush';
  armed = false;
  v.setProject(p);
  $('view').value = 'Studio';
  $('model-kind').textContent = kind;
  $('model-name').textContent = $('docname').textContent = p.name;
  ['X', 'Y', 'Z'].forEach((axis, i) => {
    $('dimensions').querySelector('.axis-' + axis).textContent = Number(v.box.size[i].toFixed(2));
  });
  $('faces').textContent = p.depth.length.toLocaleString() + ' source triangles';
  paletteUI();
  stampUI();
  toolUI();
  state();
  notify('Ready');
  refreshColorLimit();
}
async function task(message, fn) {
  if (busy) return false;
  busy = true;
  finishStroke();
  $('busy').firstElementChild.textContent = message;
  $('busy').hidden = false;
  for (const el of document.querySelectorAll('header,aside,nav,.viewbar')) el.inert = true;
  try {
    await new Promise((r) => setTimeout(r, 25));
    return await fn();
  } catch (err) {
    error(err);
    return false;
  } finally {
    busy = false;
    $('busy').hidden = true;
    for (const el of document.querySelectorAll('header,aside,nav,.viewbar')) el.inert = false;
  }
}
async function write(kind) {
  finishStroke();
  const exported = kind === 'export';
  const data = exported ? writeOrca(p) : writeProject(p);
  const name = await files.write(kind, p.name, data);
  if (!name) return false;
  if (!exported) {
    saved = revision;
    $('model-kind').textContent = 'PAINTER PROJECT';
    state();
  }
  notify((exported ? 'Exported ' : 'Saved ') + name);
  return true;
}
async function prepareToLeave() {
  finishStroke();
  if (saved === revision) return 'ready';
  const answer = await files.decide();
  if (answer === 'save') return (await write('save')) ? 'saved' : 'cancel';
  return answer === 'discard' ? 'ready' : 'cancel';
}
$('open').onclick = () =>
  task('Opening model…', async () => {
    const file = await files.open();
    if (!file) return;
    const project = /\.stlp$/i.test(file.name);
    const declared = project ? 0 : binarySTLFaceCount(file.bytes);
    checkFaceLimit(declared);
    if (declared > LARGE_MODEL_FACES && !(await files.confirmLargeModel(declared))) return;
    let next = project ? readProject(file.bytes) : readSTL(file.bytes, file.name);
    const faces = next.depth.length;
    if (!declared && faces > LARGE_MODEL_FACES && !(await files.confirmLargeModel(faces))) return;
    const decision = await prepareToLeave();
    if (decision === 'cancel') return;
    // Saving may have replaced the selected project, including via a Save As dialog.
    if (project && decision === 'saved') {
      next = readProject(await files.readPendingProject());
      if (next.depth.length > LARGE_MODEL_FACES && next.depth.length !== faces &&
          !(await files.confirmLargeModel(next.depth.length))) return;
    }
    load(next, project ? 'PAINTER PROJECT' : 'STL MODEL');
    await files.accept();
  });
$('save').onclick = () => task('Saving project…', () => write('save'));
$('save-as').onclick = () => task('Saving project as…', () => write('saveAs'));
$('export').onclick = () => task('Preparing Orca export…', () => write('export'));
files.onClose(() => task('Closing project…', async () => (await prepareToLeave()) !== 'cancel'));
$('undo').onclick = () => undo();
$('redo').onclick = () => undo(true);
for (const b of all('[data-tool]')) b.onclick = () => chooseTool(b.dataset.tool);
$('add-color').onclick = () => {
  if (p.palette.length >= 16) return;
  const oldIndex = selected,
    hex = '#7995AD';
  const change = (forward) => {
    if (forward) {
      p.palette.push(hex);
      selected = p.palette.length - 1;
    } else {
      p.palette.pop();
      selected = oldIndex;
    }
    v.refreshPalette();
  };
  clearPreview();
  change(true);
  record('Added palette color', change);
  paletteUI();
  schedulePreview();
};
function requestColorRemoval(id) {
  finishStroke();
  if (p.palette.length <= 1) return;
  if (id !== 0 && !p.paint.includes(id) && !p.stamps.some((stamp) => stamp.pixels.includes(id))) {
    removePaletteColor(id, 0);
    return;
  }
  const dialog = $('remove-color-dialog');
  const options = $('replacement-color');
  options.replaceChildren();
  p.palette.forEach((hex, i) => {
    if (i !== id) options.add(new Option(`Color ${i + 1}${i === 0 ? ' (base)' : ''} · ${hex}`, String(i)));
  });
  $('remove-color-title').textContent = 'Remove Color ' + (id + 1) + '?';
  $('remove-color-description').textContent = id === 0
    ? 'Choose the new base color. It will also replace this color on painted surfaces and in saved stamps.'
    : 'This color is in use. Choose its replacement for painted surfaces and saved stamps.';
  dialog.returnValue = '';
  dialog.onclose = () => {
    if (dialog.returnValue === 'remove') removePaletteColor(id, Number(options.value));
  };
  dialog.showModal();
}

function removePaletteColor(id, replacement) {
  if (p.palette.length <= 1 || id === replacement) return;
  const previousSelection = selected;
  const original = p.palette.slice();
  const kept = original.map((_, index) => index).filter((index) => index !== id);
  if (id === 0) {
    kept.splice(kept.indexOf(replacement), 1);
    kept.unshift(replacement);
  }
  const remaining = kept.map((index) => original[index]);
  const slots = original.map((_, index) => kept.indexOf(index === id ? replacement : index));
  const remap = (index) => index === 255 ? 255 : slots[index];
  // Preserve the original arrays so undo can separate the merged colors again.
  const updates = [];
  let weight = 0;
  function prepare(owner, key) {
    const before = owner[key];
    if (!before.some((index) => remap(index) !== index)) return;
    const after = before.map(remap);
    updates.push({ owner, key, before, after });
    weight += before.byteLength + after.byteLength;
  }
  prepare(p, 'paint');
  for (const stamp of p.stamps) prepare(stamp, 'pixels');
  const change = (forward) => {
    p.palette = (forward ? remaining : original).slice();
    for (const { owner, key, before, after } of updates) owner[key] = forward ? after : before;
    selected = forward ? remap(previousSelection) : previousSelection;
    v.refreshPalette();
  };
  clearPreview();
  change(true);
  record('Removed Color ' + (id + 1), change, weight);
  paletteUI();
  stampUI();
  schedulePreview();
  $('palette').querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
}

function editPaletteColor(id, next) {
  const prev = p.palette[id];
  if (prev.toUpperCase() === next) return;
  const change = (forward) => {
    p.palette[id] = forward ? next : prev;
    v.refreshPalette();
  };
  clearPreview();
  change(true);
  record('Changed Color ' + (id + 1), change);
  stampUI();
  schedulePreview();
}
function range(id, out, suffix, placement = false) {
  const move = () => {
    $(out).textContent = $(id).value + suffix;
    if (placement && placingArtwork()) armPreview();
  };
  $(id).oninput = move;
  move();
}
range('brush-size', 'brush-value', ' px');
const refineEdges = $('refine-edges');
const refineStamp = $('refine-stamp');
refineStamp.onchange = () => {
  localStorage.setItem(
    tool === 'Text' ? 'refineTextEdges' : 'refineStampEdges',
    refineStamp.checked ? 'on' : 'off'
  );
  armed = true;
  schedulePreview();
};
$('text-panel').addEventListener('input', armPreview);
range('text-size', 'text-size-value', ' px');
range('angle', 'angle-value', '°');
range('rotation', 'rotation-value', '°', true);
range('stamp-size', 'stamp-size-value', ' px', true);
range('cutoff', 'cutoff-value', '°', true);
$('filter').onchange = () => {
  $('cutoff-wrap').hidden = !$('filter').checked;
  armed = true;
  schedulePreview();
};
$('help').onclick = () => $('guide').showModal();
$('view').onchange = () => v.fit($('view').value);
$('fit').onclick = () => {
  $('view').value = 'Studio';
  v.fit();
};
$('projection').onclick = () => {
  const ortho = v.camera.isPerspectiveCamera;
  v.setCamera(ortho ? 'ortho' : 'perspective');
  $('projection').textContent = ortho ? 'Orthographic' : 'Perspective';
};
$('import-image').onclick = () => $('image-input').click();
$('image-input').onchange = async () => {
  const file = $('image-input').files[0];
  $('image-input').value = '';
  if (!file) return;
  await task('Reading artwork…', async () => {
    art = await loadArtwork(file);
    if (p.stamps.reduce((n, s) => n + s.source.length, 0) + art.source.length > 96 * 1024 * 1024)
      throw Error('The project artwork limit is 96 MB.');
    $('limit').max = Math.max(1, 16 - p.palette.length);
    $('limit').value = Math.min(3, 16 - p.palette.length);
    $('mapping-mode').value = 'existing';
    $('stamp-opacity').value = $('stamp-opacity').defaultValue;
    $('mapping-mode').options[1].disabled = p.palette.length >= 16;
    $('image-name').textContent = art.name;
    $('show-removed').checked = false;
    convert();
    $('mapping').showModal();
    importPreview.fit();
  });
};
function convert() {
  const add = $('mapping-mode').value === 'add';
  $('limit-row').hidden = !add;
  $('limit-value').textContent = $('limit').value;
  const cutoff = +$('stamp-opacity').value;
  $('stamp-opacity-value').textContent = cutoff + '%';
  $('stamp-opacity').setAttribute('aria-valuetext', cutoff + '%');
  conversion = mapImage(art.data, p.palette, add ? +$('limit').value : 0, cutoff);
  const palette = [...p.palette, ...conversion.added];
  renderImportPreview();
  $('mapped-colors').replaceChildren();
  const used = new Set(conversion.pixels);
  used.delete(255);
  $('confirm-import').disabled = !used.size;
  $('empty-mask').hidden = !!used.size;
  for (const i of used) {
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.setProperty('--swatch', palette[i]);
    sw.title = 'Color ' + (i + 1) + (i >= p.palette.length ? ' (new)' : '');
    $('mapped-colors').append(sw);
  }
}
function renderImportPreview() {
  const stamp = { ...art, pixels: conversion.pixels };
  importPreview.show(stampCanvas(stamp, [...p.palette, ...conversion.added], $('show-removed').checked));
}
$('show-removed').onchange = renderImportPreview;
$('mapping-mode').onchange = convert;
$('limit').oninput = convert;
$('stamp-opacity').oninput = convert;
$('mapping').onclose = () => {
  if ($('mapping').returnValue === 'import' && art && !$('confirm-import').disabled) {
    clearPreview();
    const { data, ...stamp } = art;
    stamp.pixels = conversion.pixels;
    const added = conversion.added,
      prior = stampIndex;
    const change = (forward) => {
      if (forward) {
        p.palette.push(...added);
        p.stamps.push(stamp);
        stampIndex = p.stamps.length - 1;
      } else {
        p.palette.splice(p.palette.length - added.length, added.length);
        p.stamps.pop();
        stampIndex = prior;
      }
      v.refreshPalette();
    };
    change(true);
    record('Imported stamp', change, stamp.source.length + stamp.pixels.length);
    armed = true;
    anchor = { x: v.w / 2, y: v.h / 2 };
    paletteUI();
    stampUI();
    schedulePreview();
  }
  art = null;
  conversion = null;
  $('mapping').returnValue = '';
};
$('apply').onclick = () => {
  if (draggingArtwork) return;
  if (previewFrame) updatePreview();
  if (!hasPreview()) return;
  const changes = preview;
  preview = new Map();
  armed = false;
  $('stamp-outline').hidden = true;
  stroke = {
    old: new Map(),
    label: tool === 'Text' ? 'Applied text' : 'Applied stamp',
    refiner: refinedPreview,
  };
  if (refinedPreview) {
    v.clearPaintPreview();
    refinedPreview = null;
  }
  for (const [id, c] of changes) setColor(id, c);
  v.recolor();
  finishStroke();
  $('apply').disabled = true;
};
function bindCanvas() {
  const canvas = v.canvas;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Model painting surface');
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  let last = null,
    pointerId = null;
  function cursor(pos) {
    const el = $('pointer');
    el.hidden = !['Brush', 'Eraser'].includes(tool);
    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';
    el.style.width = el.style.height = $('brush-size').value + 'px';
  }
  function dab(a, b) {
    if (stroke.refiner) {
      stroke.refiner.dab(a, b, +$('brush-size').value / 2);
      state();
      return;
    }
    v.stroke(a, b, +$('brush-size').value / 2, (id) =>
      setColor(id, tool === 'Eraser' ? 0 : selected)
    );
    v.recolor();
    state();
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (busy || pointerId !== null) return;
    if (e.button !== 0) {
      $('pointer').hidden = true;
      return;
    }
    canvas.focus({ preventScroll: true });
    if (tool === 'Stamps' && stampIndex < 0) return;
    const pt = point(e);
    pointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'Fill') {
      const seed = v.pick(pt.x, pt.y);
      if (seed < 0) return;
      stroke = { old: new Map(), label: 'Filled region' };
      for (const id of flood(p, v.surface, seed, +$('angle').value, $('protect').checked))
        setColor(id, selected);
      v.recolor();
      finishStroke();
    } else if (placingArtwork()) {
      draggingArtwork = true;
      $('apply').disabled = true;
      anchor = pt;
      armed = true;
      schedulePreview();
    } else {
      last = pt;
      stroke = { old: new Map(), label: tool === 'Brush' ? 'Painted stroke' : 'Erased stroke' };
      if (refineEdges.checked)
        stroke.refiner = new RefinedStroke(v, tool === 'Eraser' ? 0 : selected);
      dab(pt, pt);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (busy) return;
    const pt = point(e);
    if (e.buttons && !(e.buttons & 1)) {
      return;
    }
    cursor(pt);
    if (pointerId !== e.pointerId) return;
    if (draggingArtwork && placingArtwork()) {
      anchor = pt;
      armed = true;
      schedulePreview();
    } else if (stroke && last) {
      dab(last, pt);
      last = pt;
    }
  });
  function end(e) {
    if (e.pointerId !== undefined && e.pointerId !== pointerId) return;
    if (draggingArtwork) {
      if (e.type === 'pointerup') anchor = point(e);
      draggingArtwork = false;
      schedulePreview();
    }
    finishStroke();
    last = null;
    pointerId = null;
  }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);
  canvas.addEventListener('pointerleave', () => {
    $('pointer').hidden = true;
  });
  window.addEventListener('blur', end);
}
window.addEventListener('keydown', (e) => {
  if (busy || e.isComposing || document.querySelector('dialog[open], #slice-details:popover-open')) return;
  const k = e.key.toLowerCase(),
    ctrl = e.ctrlKey || e.metaKey;
  if (k === 'escape' && placingArtwork()) {
    e.preventDefault();
    if (tool === 'Stamps') anchor = null;
    chooseTool('Brush');
    v.canvas.focus({ preventScroll: true });
    return;
  }
  if (e.target.matches('textarea') && !(ctrl && ['s', 'o'].includes(k))) return;
  if (ctrl) {
    const action = {
      o: 'open',
      s: e.shiftKey ? 'save-as' : 'save',
      z: e.shiftKey ? 'redo' : 'undo',
      y: 'redo',
    }[k];
    if (action) {
      e.preventDefault();
      $(action).click();
    }
    return;
  }
  if (e.target.matches('input,select') && !e.target.matches('input[type=range]')) return;
  if ('bfest'.includes(k) && k.length === 1) {
    e.preventDefault();
    chooseTool({ b: 'Brush', f: 'Fill', e: 'Eraser', s: 'Stamps', t: 'Text' }[k]);
  }
  if (k === 'home') {
    e.preventDefault();
    $('fit').click();
  }
  if (k === 'enter' && placingArtwork() && !e.target.matches('button')) {
    e.preventDefault();
    if (previewFrame && !draggingArtwork) updatePreview();
    $('apply').click();
  }
  if (k === '[' || k === ']') {
    $('brush-size').value = +$('brush-size').value + (k === '[' ? -2 : 2);
    $('brush-size').oninput();
  }
});
try {
  v = new Viewport($('viewport'), (view) => {
    $('view').value = view;
    schedulePreview();
  });
  load(sampleProject(), 'SAMPLE MODEL');
  bindCanvas();
} catch (err) {
  error(err);
  notify('The 3D workspace could not start.');
}
