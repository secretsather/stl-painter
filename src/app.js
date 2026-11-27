import {
  createIcons,
  FolderOpen,
  Save,
  Ellipsis,
  ChevronDown,
  Box,
  Paintbrush,
  PaintBucket,
  Layers,
  Lasso,
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
  Lock,
  LockOpen,
  X,
} from 'lucide';
import { Viewport } from './viewport.js';
import { setupSidebar } from './sidebar.js';
import { setupImportPreview } from './import-preview.js';
import { RefinedStroke } from './refined-stroke.js';
import { applyLeafEdits, mergeRepaintedCells } from './paint-tree.js';
import { bandEdits } from './band.js';
import { lassoFootprint, lassoSegments } from './lasso.js';
import { binarySTLFaceCount, checkFaceLimit, LARGE_MODEL_FACES, MAX_CELLS } from './mesh.js';
import { FillPreview, drawFillPreview, drawSurfaceHighlight } from './fill-preview.js';
import { hasMultipleSwatches } from './fill-gaps.js';
import { modelJob, FillJobs } from './model-job.js';
import { textArtwork, loadFontFamilies } from './text-artwork.js';
import { setupColorLimit } from './color-limit.js';
import { stampCanvas, loadArtwork } from './stamps.js';
import { MAX_FILAMENTS, MAX_SWATCHES, physicalSlots, filamentMasks, mixHex, recipeLabel, suggestFilament } from './mixes.js';
import { chooseMix } from './mix-editor.js';
import { paletteMapping, readPalette, writePalette } from './palette-file.js';

const $ = (id) => document.getElementById(id),
  all = (q) => [...document.querySelectorAll(q)];
const icons = {
  FolderOpen,
  Save,
  Ellipsis,
  ChevronDown,
  Box,
  Paintbrush,
  PaintBucket,
  Layers,
  Lasso,
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
const toolByKey = new Map();
for (const button of all('.toolrail [data-tool]')) {
  const key = button.getAttribute('aria-keyshortcuts') || button.dataset.tool[0];
  button.setAttribute('aria-keyshortcuts', key);
  toolByKey.set(key.toLowerCase(), button.dataset.tool);
  const item = document.createElement('span'), cap = document.createElement('kbd');
  item.className = 'shortcut';
  cap.textContent = key;
  const icon = button.querySelector('svg').cloneNode(true);
  icon.setAttribute('aria-hidden', 'true');
  item.append(icon, cap, button.getAttribute('aria-label'));
  $('tool-shortcuts').append(item);
}
setupSidebar($('sidebar-divider'));
const importPreview = setupImportPreview($('mapping-preview'), $('fit-artwork'));
const files = window.painterFiles;
let p,
  v,
  tool = 'Brush',
  pickingFace = false,
  samplingColor = false,
  selected = 1,
  stampIndex = -1,
  anchor = null,
  armed = false,
  draggingArtwork = false,
  stampSizePointer = null,
  stampPreviewDeferred = false,
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
let paintRevision = 0;
const refreshColorLimit = setupColorLimit(() => ({
  paint: p.paint, paintRevision,
  palette: physicalSlots(p).map(slot => p.palette[slot]),
  masks: filamentMasks(p),
  surface: v.surface,
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
function setDocumentName(name, isProject) {
  const header = $('docname');
  header.textContent = name;
  header.title = name;
  $('model-name').textContent = isProject ? name.replace(/\.stlp$/i, '') || name : name;
}
let nativeDirty;
function state() {
  const pendingStroke = !!stroke?.old.size || !!stroke?.refiner?.edits.size;
  const changed = revision !== saved || pendingStroke;
  $('dirty').hidden = !changed;
  const title = (changed ? '• ' : '') + $('docname').textContent + ' — STL Painter';
  if (document.title !== title) document.title = title;
  if (nativeDirty !== changed) {
    files.dirty(changed);
    nativeDirty = changed;
  }
  $('undo').disabled = !history.length && !pendingStroke;
  $('redo').disabled = !future.length;
}
function record(label, change, weight = 0, scope = 'paint') {
  const before = revision;
  revision = ++sequence;
  history.push({ label, change, before, after: revision, weight, scope });
  future = [];
  let size = history.reduce((sum, h) => sum + h.weight, 0);
  while (history.length > 1 && (size > 48000000 || history.length > 80))
    size -= history.shift().weight;
  state();
  notify(label);
  if (scope === 'paint') paintRevision++;
  if (scope === 'paint' || scope === 'palette') refreshColorLimit();
  if (tool === 'Fill Gaps') refreshGaps();
}
let textKey, textMask, fontList;
// Rasterize physical lettering at a stable resolution. Its projected size can
// change with the camera without changing the font metrics or rebuilding the mask.
const physicalFontPixels = 96;
function placingArtwork() {
  return tool === 'Stamps' || tool === 'Text';
}
function currentArtwork() {
  if (tool === 'Stamps') return p.stamps[stampIndex];
  if (tool !== 'Text') return null;
  const settings = {
    text: $('text-content').value,
    family: $('text-font').value,
    size: sizes.text.physical ? physicalFontPixels : +$('text-size').value,
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
  cancelLasso();
  clearFillHover();
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
  const artwork = !samplingColor && armed && currentArtwork();
  if (!artwork) {
    $('apply').disabled = true;
    return;
  }
  anchor ??= { x: v.w / 2, y: v.h / 2 };
  const text = tool === 'Text';
  const width = text
    ? artwork.placementWidth * (sizes.text.physical ? sizes.text.pixelsAt(anchor) / physicalFontPixels : 1)
    : sizes.stamp.pixelsAt(anchor);
  const placement = {
    ...anchor,
    width,
    rotation: +$('rotation').value,
    workspace: !text && !sizes.stamp.physical ? { width: v.w, height: v.h } : undefined,
    filter: $('filter').checked,
    cutoff: +$('cutoff').value,
  };
  const footprint = v.stampFootprint(artwork, placement);
  const resizingStamp = !text && stampSizePointer !== null && !sizes.stamp.physical;
  const quickPreview = draggingArtwork || resizingStamp;
  if (tool === 'Stamps') {
    const outline = $('stamp-outline');
    outline.style.left = footprint.center.x + 'px';
    outline.style.top = footprint.center.y + 'px';
    outline.style.width = placement.width + 'px';
    outline.style.height = (placement.width * artwork.height / artwork.width) + 'px';
    outline.style.transform = `translate(-50%, -50%) rotate(${placement.rotation}deg)`;
    outline.hidden = false;
    if (resizingStamp) stampPreviewDeferred = true;
    else anchor = footprint.center;
  }
  if (!quickPreview && $('refine-stamp').checked) {
    refinedPreview = new RefinedStroke(v);
    refinedPreview.projectFootprint(footprint);
    if (refinedPreview.edits.size) v.previewPaint(refinedPreview.edits);
  } else {
    preview = quickPreview ? v.dragStamp(footprint) : v.stamp(footprint);
    for (const [id, color] of preview) v.color(id, color);
    if (preview.size) v.recolor();
  }
  $('apply').disabled = quickPreview || !hasPreview();
}
function schedulePreview() {
  if (!v || !p || samplingColor || !placingArtwork() || !armed || previewFrame) return;
  previewFrame = requestAnimationFrame(updatePreview);
}
function setColor(id, c) {
  if (p.paint[id] === c || p.lockedSlots.has(p.paint[id])) return;
  if (!stroke.old.has(id)) stroke.old.set(id, p.paint[id]);
  p.paint[id] = c;
  v.color(id, c);
}
function finishStroke() {
  if (!stroke) return;
  const { old, label, refiner } = stroke;
  stroke = null;
  if (refiner) {
    refiner.dispose();
    commitLeafEdits(refiner.edits, label + (refiner.limited ? ' (detail limit reached)' : ''));
    return;
  }
  if (!old.size) return;
  const ids = Uint32Array.from(old.keys());
  recordColors(label, ids, Uint8Array.from(old.values()), idsToColors(ids));
}
function commitLeafEdits(edits, label) {
  if (!edits.size) return;
  for (const tree of edits.values()) {
    if (typeof tree === 'number') continue;
    recordSurfaceChange(label, applyLeafEdits(p, edits, v.ranges));
    return;
  }
  const ids = Uint32Array.from(edits.keys()), before = idsToColors(ids);
  for (const [id, color] of edits) {
    p.paint[id] = color;
    v.color(id, color);
  }
  v.recolor();
  recordColors(label, ids, before, Uint8Array.from(edits.values()));
}
function recordColors(label, ids, before, after) {
  const merged = mergeRepaintedCells(p, v.ranges, ids);
  if (merged) {
    // A plain brush updates colors in place during the drag. Restore the old
    // slots in the before-state so Undo restores both the edge and its paint.
    ids.forEach((id, i) => { p.paint[id] = before[i]; });
    recordSurfaceChange(label, merged);
    return;
  }
  record(
    label,
    (forward) => {
      const colors = forward ? after : before;
      ids.forEach((id, i) => {
        p.paint[id] = typeof colors === 'number' ? colors : colors[i];
        v.color(id, p.paint[id]);
      });
      v.recolor();
    },
    ids.byteLength + before.byteLength + (after.byteLength ?? 0)
  );
}
function updatePaintTriangleCount() {
  $('paint-triangles').textContent = p.paint.length.toLocaleString() + ' / ' + MAX_CELLS.toLocaleString() + ' paint triangles';
}
function recordSurfaceChange(label, after) {
  const before = { paint: p.paint, splits: p.splits, ranges: v.ranges };
  const change = forward => {
    const state = forward ? after : before;
    p.paint = state.paint;
    p.splits = state.splits;
    v.rebuildSurface(state.ranges, after.changed);
    updatePaintTriangleCount();
  };
  change(true);
  record(label, change, before.paint.length + (before.splits?.length ?? 0) +
    after.paint.length + (after.splits?.length ?? 0));
}
function idsToColors(ids) {
  return Uint8Array.from(ids, (id) => p.paint[id]);
}
function undo(redo = false) {
  cancelBand();
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
  if (h.scope !== 'paint') {
    paletteUI();
    stampUI();
  }
  toolUI();
  state();
  notify((redo ? 'Redid ' : 'Undid ') + h.label.toLowerCase());
  if (h.scope === 'paint') paintRevision++;
  if (h.scope === 'paint' || h.scope === 'palette') refreshColorLimit();
  if (tool === 'Fill Gaps') refreshGaps();
  scheduleFillHover();
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
function swatchName(slot) {
  return p.mixes?.[slot] ? 'Mix ' + (Object.keys(p.mixes).indexOf(String(slot)) + 1)
    : 'Color ' + (physicalSlots(p).indexOf(slot) + 1);
}
const swatchKeys = '1234567890';
function setExpanded(button, expanded) {
  button.setAttribute('aria-expanded', String(expanded));
  $(button.getAttribute('aria-controls')).hidden = !expanded;
}
for (const button of all('.panel-toggle')) {
  button.onclick = () => setExpanded(button, button.getAttribute('aria-expanded') !== 'true');
}
function revealPanel(id) {
  setExpanded(document.querySelector(`[aria-controls="${id}"]`), true);
}
function selectSwatch(slot) {
  document.querySelector('.swatch-row [aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
  selected = slot;
  if (lasso?.closed) previewLasso();
  document.querySelector(`[data-swatch="${slot}"]`).setAttribute('aria-pressed', 'true');
  refreshFillHover();
  if (tool === 'Text') armPreview();
  if (tool === 'Band') {
    if (bandLower.valueAsNumber < bandUpper.valueAsNumber) bandPending = true;
    updateBand();
  }
}
function swatchLock(slot, name) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'swatch-lock';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', 'Protect ' + name);
  const locked = p.lockedSlots.has(slot);
  button.setAttribute('aria-checked', String(locked));
  button.title = (locked ? 'Unlock ' : 'Lock ') + name + ' on the model';
  const icon = document.createElement('i');
  icon.dataset.lucide = locked ? 'lock' : 'lock-open';
  button.append(icon);
  button.onclick = () => {
    finishStroke();
    clearPreview();
    const change = forward => {
      const protect = forward ? !locked : locked;
      if (protect) p.lockedSlots.add(slot);
      else p.lockedSlots.delete(slot);
    };
    change(true);
    record((locked ? 'Unlocked ' : 'Locked ') + name, change, 0, 'locks');
    paletteUI();
    document.querySelector(`[data-swatch="${slot}"] + .swatch-lock`).focus({ preventScroll: true });
    schedulePreview();
    scheduleFillHover();
  };
  return button;
}
function paletteUI() {
  const list = $('palette');
  list.replaceChildren();
  const mixedList = $('mixed-colors'), physical = physicalSlots(p);
  mixedList.replaceChildren();
  p.palette.forEach((hex, i) => {
    const row = document.createElement('div');
    row.className = 'swatch-row';
    const name = swatchName(i), parts = p.mixes?.[i];
    const picker = document.createElement(parts ? 'button' : 'input');
    if (parts) {
      picker.className = 'mix-chip';
      picker.style.setProperty('--swatch', hex);
    } else {
      picker.type = 'color';
      picker.className = 'palette-picker';
      picker.value = hex;
    }
    picker.title = 'Edit ' + name;
    picker.setAttribute('aria-label', picker.title);
    const b = document.createElement('button');
    b.dataset.swatch = i;
    b.setAttribute('aria-label', name + (i === 0 ? ' (base)' : ''));
    b.setAttribute('aria-pressed', String(i === selected));
    const code = document.createElement('span');
    code.className = 'palette-hex';
    code.textContent = hex.toUpperCase();
    if (parts) {
      b.className = 'mix-choice';
      const heading = document.createElement('span');
      heading.className = 'mix-heading';
      heading.append(name, code);
      const recipe = document.createElement('small');
      parts.forEach((part, index) => {
        const ingredient = document.createElement('span');
        ingredient.textContent = (index ? '+ ' : '') + recipeLabel([part], physical);
        if (index) recipe.append(' ');
        recipe.append(ingredient);
      });
      b.setAttribute('aria-description', recipe.textContent);
      b.append(heading, recipe);
    } else {
      const heading = document.createElement('span');
      heading.className = 'solid-heading';
      const label = document.createElement('span');
      label.textContent = name;
      heading.append(code, label);
      if (i === 0) {
        const tag = document.createElement('span');
        tag.className = 'base';
        tag.textContent = 'Base';
        heading.append(tag);
      }
      b.append(heading);
    }
    const icon = document.createElement('i');
    icon.dataset.lucide = 'check';
    b.append(icon);
    b.onclick = () => selectSwatch(i);
    picker.onclick = parts ? () => editMix(i) : b.onclick;
    picker.onchange = () => {
      const next = picker.value.toUpperCase();
      const existing = p.palette.indexOf(next);
      if (existing !== -1 && existing !== i) {
        picker.value = p.palette[i];
        notify(`${swatchName(existing)} already uses ${next}. Choose a different color.`);
        return;
      }
      editPaletteColor(i, next);
    };
    row.append(picker, b, swatchLock(i, name));
    if (p.palette.length > 1) row.append(removeButton('Remove ' + name, () => requestColorRemoval(i)));
    (parts ? mixedList : list).append(row);
  });
  // Sidebar order groups physical filaments first, even if a mix was saved earlier.
  all('.swatch-row [data-swatch]').slice(0, swatchKeys.length).forEach((button, index) => {
    const key = swatchKeys[index], cap = document.createElement('kbd');
    cap.textContent = key;
    cap.setAttribute('aria-hidden', 'true');
    button.firstElementChild.prepend(cap);
    button.setAttribute('aria-keyshortcuts', key);
    button.title = button.getAttribute('aria-label') + ' (' + key + ')';
  });
  for (const root of [list, mixedList]) createIcons({ icons: { Check, Lock, LockOpen }, root });
  if (!mixedList.childElementCount) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = physical.length < 2 ? 'Add a second filament to create a mix.' : 'Use + to mix two or three filaments.';
    mixedList.append(hint);
  }
  $('add-color').disabled = physical.length >= MAX_FILAMENTS || p.palette.length >= MAX_SWATCHES;
  $('add-mix').disabled = physical.length < 2 || p.palette.length >= MAX_SWATCHES;
  if (tool === 'Band') updateBand();
}
const stampRows = new WeakMap();
function stampUI() {
  const list = $('stamp-list');
  p.stamps.forEach((stamp, i) => {
    let entry = stampRows.get(stamp);
    if (!entry) {
      const row = document.createElement('div'), button = document.createElement('button');
      row.className = 'stamp-row';
      button.className = 'stamp-choice';
      const name = document.createElement('span');
      name.textContent = stamp.name;
      button.append(name);
      button.onclick = () => {
        clearPreview();
        stampIndex = p.stamps.indexOf(stamp);
        armed = true;
        stampUI();
        updatePreview();
      };
      row.append(button, removeButton('Remove stamp ' + stamp.name, () => removeStamp(p.stamps.indexOf(stamp))));
      entry = { row, button };
      stampRows.set(stamp, entry);
    }
    const changedPixels = entry.pixels !== stamp.pixels;
    if (changedPixels) {
      entry.pixels = stamp.pixels;
      entry.slots = [...new Set(stamp.pixels)].filter(slot => slot !== 255);
    }
    const colors = entry.slots.map(slot => p.palette[slot]).join('');
    if (changedPixels || entry.colors !== colors) {
      const thumbnail = stampCanvas(stamp, p.palette, false, Math.ceil(28 * devicePixelRatio));
      if (entry.canvas) entry.canvas.replaceWith(thumbnail);
      else entry.button.prepend(thumbnail);
      entry.canvas = thumbnail;
      entry.colors = colors;
    }
    entry.button.setAttribute('aria-pressed', String(i === stampIndex));
    if (list.children[i] !== entry.row) list.insertBefore(entry.row, list.children[i] ?? null);
  });
  while (list.children.length > p.stamps.length) list.lastElementChild.remove();
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
  record('Removed stamp ' + stamp.name, change, stamp.source.byteLength + stamp.pixels.byteLength, 'library');
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
  Band: 'Click twice to set the bounds, or enter both distances.',
  Fill: 'Hover to preview. Tap [ or ] for 1°, or hold to keep adjusting. Click to fill.',
  'Fill Gaps': 'Preview small patches enclosed by one swatch. Apply fills them together. Esc cancels.',
  'Fill Lasso': 'Click to place nodes. Backspace removes the last node. After three or more, click the first node to close and preview. Apply paints the area. Esc cancels.',
  Eraser: 'Drag to expose the current base color.',
  Text: 'Click or drag to position your text. Press Esc to cancel and return to Brush.',
  Stamps: 'Click or drag to position the stamp. Press Esc to cancel and return to Brush.',
};
function toolUI() {
  $('tool-hint').textContent = hints[tool];
  for (const b of all('[data-tool]')) {
    const active = b.dataset.tool === tool;
    b.setAttribute('aria-pressed', String(active));
    if (active) {
      $('tool-title').textContent = b.getAttribute('aria-label');
      $('tool-key').textContent = b.getAttribute('aria-keyshortcuts');
      $('tool-symbol').replaceChildren(b.querySelector('svg').cloneNode(true));
    }
  }
  $('brush-panel').hidden = !['Brush', 'Eraser'].includes(tool);
  $('edge-control').hidden = $('brush-panel').hidden && tool !== 'Fill Lasso';
  $('lasso-panel').hidden = tool !== 'Fill Lasso';
  $('fill-panel').hidden = tool !== 'Fill';
  $('gap-panel').hidden = tool !== 'Fill Gaps';
  $('band-panel').hidden = tool !== 'Band';
  if (tool === 'Band') updateBand();
  $('stamp-panel').hidden = tool !== 'Stamps';
  const text = tool === 'Text';
  if (text) fontList ??= loadFontFamilies($('text-font')).then(schedulePreview);
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
const bandLower = $('band-lower'), bandUpper = $('band-upper');
const bandDirection = $('band-direction');
let bandStart = null, bandHover = null, bandPending = false;
function updateBand() {
  let low = bandLower.valueAsNumber, high = bandUpper.valueAsNumber;
  const ready = bandPending && low < high;
  $('apply-band').disabled = !ready;
  const axis = Number(bandDirection.value);
  let hint = hints.Band + ' Zero is at the ' + ['left', 'front', 'bottom'][axis] + ' of the model.';
  if (bandStart !== null) {
    hint = 'Click the second bound, on or off the model. Esc cancels.';
    if (bandHover !== null) {
      low = Math.min(bandStart, bandHover);
      high = Math.max(bandStart, bandHover);
    }
  } else if (ready) hint = 'Adjust either bound, then choose Apply band. Esc cancels.';
  else if (bandPending && low >= high) hint = 'To must be greater than From.';
  $('tool-hint').textContent = hint;
  if (bandPending && low < high && !samplingColor)
    v.showBand(v.box.min[axis] + low, v.box.min[axis] + high, p.palette[selected], revision, axis);
  else v.showBand(1, 0);
}
function cancelBand() {
  if (!bandPending) return;
  bandPending = false;
  bandStart = bandHover = null;
  bandLower.value = bandUpper.value = '';
  updateBand();
}
function pickBandBound(position) {
  // A single manually entered value can also be the first endpoint.
  const first = bandStart ?? (bandLower.value === '' ? bandUpper.valueAsNumber :
    bandUpper.value === '' ? bandLower.valueAsNumber : NaN);
  bandPending = true;
  bandHover = null;
  if (Number.isFinite(first)) {
    bandLower.value = Math.min(first, position);
    bandUpper.value = Math.max(first, position);
    bandStart = null;
  } else {
    bandStart = position;
    bandLower.value = position;
    bandUpper.value = '';
  }
  updateBand();
}
function applyBand() {
  if ($('apply-band').disabled) return;
  const axis = Number(bandDirection.value), origin = v.box.min[axis];
  const low = origin + bandLower.valueAsNumber, high = origin + bandUpper.valueAsNumber;
  task('Painting band…', () => {
    const edits = bandEdits(v.chunks, p.paint, axis, low, high, selected, p.lockedSlots);
    bandPending = false;
    updateBand();
    if (edits.size) commitLeafEdits(edits, 'Painted band');
    else notify('No editable paint would change in this band.');
  });
}
bandLower.oninput = bandUpper.oninput = () => {
  bandPending = true;
  bandStart = bandHover = null;
  updateBand();
};
bandDirection.onchange = () => {
  bandHover = null;
  if (bandLower.valueAsNumber < bandUpper.valueAsNumber) bandPending = true;
  updateBand();
};
$('apply-band').onclick = applyBand;
let fillJobs;
const fillLayer = $('fill-highlight').firstElementChild;
const fillPreview = new FillPreview(findFillRegion, mask =>
  drawFillPreview(fillLayer, v, mask, p.paint, selected, p.palette[selected]));
let fillPoint, fillFrame = 0;
function clearFillHover() {
  cancelAnimationFrame(fillFrame);
  fillFrame = 0;
  fillPreview.clear();
}
function fillSeed(point) {
  const seed = v.pick(point.x, point.y);
  return p.lockedSlots.has(p.paint[seed]) || ($('protect').checked && p.paint[seed] === selected) ? -1 : seed;
}
function scheduleFillHover() {
  if (!fillPoint || tool !== 'Fill' || busy || pickingFace || samplingColor || fillFrame) return;
  fillFrame = requestAnimationFrame(() => {
    fillFrame = 0;
    fillPreview.hover(fillPoint ? fillSeed(fillPoint) : -1);
  });
}
function refreshFillHover() {
  clearFillHover();
  scheduleFillHover();
}
function prepareFill() {
  const surface = v.surface;
  if (fillJobs?.closed) {
    fillJobs = null;
    delete surface.graphJob;
  }
  const jobs = fillJobs ??= new FillJobs();
  surface.graphJob ??= jobs.prepare(p, v).catch(error => {
    delete surface.graphJob;
    if (fillJobs === jobs) {
      jobs.close();
      fillJobs = null;
    }
    throw error;
  });
  return surface.graphJob;
}
const gapWidth = $('gap-width'), applyGaps = $('apply-gaps');
const gapSeams = $('gap-seams');
const gapSpinner = $('gap-spinner');
let gapGeneration = 0, gapTimer = 0, gapFrame = 0, gapSearching = false, gapResult, scanningWorker;
function clearGaps() {
  gapGeneration++;
  if (scanningWorker) {
    scanningWorker.close('Gap preview canceled.');
    scanningWorker = null;
  }
  clearTimeout(gapTimer);
  cancelAnimationFrame(gapFrame);
  gapTimer = gapFrame = 0;
  gapResult = null;
  gapSpinner.hidden = true;
  v.showGapColors(null);
  fillLayer.parentElement.hidden = true;
  applyGaps.disabled = true;
}
function renderGaps() {
  if (!gapResult?.count || gapFrame) return;
  gapFrame = requestAnimationFrame(() => {
    gapFrame = 0;
    fillLayer.parentElement.hidden = samplingColor;
    v.showGapColors(samplingColor ? null : gapResult.targets);
    if (!samplingColor) drawSurfaceHighlight(fillLayer, v, id => id < 0 ? 255 : gapResult.targets[id], p.palette, true);
  });
}
function refreshGaps() {
  clearGaps();
  if (!(gapWidth.valueAsNumber > 0)) {
    $('gap-count').textContent = 'Enter a size greater than zero.';
    return;
  }
  if (!hasMultipleSwatches(p.paint)) {
    $('gap-count').textContent = '0 gaps to fill';
    return;
  }
  $('gap-count').textContent = 'Checking surface…';
  gapSpinner.hidden = false;
  gapTimer = setTimeout(searchGaps, 100);
}
async function searchGaps() {
  gapTimer = 0;
  if (gapSearching) return;
  gapSearching = true;
  const generation = gapGeneration;
  try {
    await prepareFill();
    if (generation !== gapGeneration) return;
    scanningWorker = fillJobs;
    const result = await scanningWorker.gaps(v, p, gapWidth.valueAsNumber, gapSeams.checked, percent => {
      if (generation === gapGeneration) $('gap-count').textContent = 'Checking thin seams… ' + percent + '%';
    });
    if (generation !== gapGeneration) return;
    gapResult = result;
    $('gap-count').textContent = result.count === 1 ? '1 gap to fill' : result.count.toLocaleString() + ' gaps to fill';
    applyGaps.disabled = !result.count;
    renderGaps();
  } catch (err) {
    if (generation === gapGeneration) {
      $('gap-count').textContent = 'Could not preview gaps.';
      error(err);
    }
  } finally {
    if (generation === gapGeneration) gapSpinner.hidden = true;
    scanningWorker = null;
    gapSearching = false;
    if (generation !== gapGeneration && tool === 'Fill Gaps' && !gapTimer &&
        gapWidth.valueAsNumber > 0 && hasMultipleSwatches(p.paint)) searchGaps();
  }
}
gapWidth.oninput = refreshGaps;
gapSeams.onchange = refreshGaps;
applyGaps.onclick = () => {
  if (!gapResult?.count || busy) return;
  const { targets, count } = gapResult;
  chooseTool('Brush');
  refreshColorLimit.beforeStroke();
  let changed = 0;
  for (const slot of targets) if (slot !== 255) changed++;
  const ids = new Uint32Array(changed), before = new Uint8Array(changed), after = new Uint8Array(changed);
  for (let i = 0, k = 0; i < targets.length; i++) {
    if (targets[i] === 255) continue;
    ids[k] = i;
    before[k] = p.paint[i];
    after[k++] = targets[i];
    p.paint[i] = targets[i];
    v.color(i, targets[i]);
  }
  v.recolor();
  recordColors('Filled ' + count + (count === 1 ? ' gap' : ' gaps'), ids, before, after);
};
async function findFillRegion(seed) {
  const surface = v.surface, angle = +$('angle').value, protect = $('protect').checked;
  await prepareFill();
  if (v.surface !== surface) return null;
  const jobs = fillJobs;
  try {
    return await jobs.region(p.paint, paintRevision, seed, angle, protect, p.lockedSlots);
  } catch (error) {
    if (fillJobs === jobs) {
      delete surface.graphJob;
      jobs.close();
      fillJobs = null;
    }
    throw error;
  }
}
function applyFill(mask) {
  if (!mask) return;
  const color = selected;
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] && p.paint[i] !== color) count++;
  if (!count) return;
  const ids = new Uint32Array(count), before = new Uint8Array(count);
  for (let i = 0, n = 0; i < mask.length; i++) {
    if (!mask[i] || p.paint[i] === color) continue;
    ids[n] = i;
    before[n++] = p.paint[i];
  }
  refreshColorLimit.beforeStroke();
  for (const id of ids) {
    p.paint[id] = color;
    v.color(id, color);
  }
  v.recolor();
  recordColors('Filled region', ids, before, color);
}
function chooseTool(name) {
  if (tool === 'Fill Gaps') clearGaps();
  cancelBand();
  stopFillAngleRepeat();
  if (pickingFace) setFacePicking(false);
  draggingArtwork = false;
  finishStroke();
  clearPreview();
  tool = name;
  if (tool === 'Fill Gaps') refreshGaps();
  if (tool === 'Fill') prepareFill().catch(() => {});
  armed = tool === 'Text';
  if (tool === 'Stamps') {
    stampIndex = -1;
    anchor = null;
    stampUI();
  }
  toolUI();
  if (tool === 'Text') $('text-content').focus();
  schedulePreview();
  scheduleFillHover();
}
function load(project, kind, documentName = project.name, prepared) {
  if (tool === 'Fill Gaps') clearGaps();
  cancelBand();
  if (pickingFace) setFacePicking(false);
  draggingArtwork = false;
  if (v?.project) clearPreview();
  p = project;
  history = [];
  future = [];
  revision = saved = 0;
  stroke = null;
  anchor = null;
  const context = p.editingContext;
  gapWidth.value = Number.isFinite(context?.gapWidth) && context.gapWidth > 0 ? context.gapWidth : 0.5;
  gapSeams.checked = context?.gapSeams === true;
  const locks = Array.isArray(context?.lockedSlots) ? context.lockedSlots : [];
  p.lockedSlots = new Set(locks.filter(i => Number.isInteger(i) && i >= 0 && i < p.palette.length));
  const bounds = context?.bandBounds;
  bandDirection.value = [0, 1, 2].includes(bounds?.axis) ? String(bounds.axis) : '2';
  bandLower.value = Number.isFinite(bounds?.lower) ? bounds.lower : '';
  bandUpper.value = Number.isFinite(bounds?.upper) ? bounds.upper : '';
  for (const [name, size] of Object.entries(sizes)) size.restore(context?.sizes?.[name]);
  const color = typeof context?.color === 'string' ? p.palette.indexOf(context.color.toUpperCase()) : -1;
  selected = color >= 0 ? color : Math.min(kind === 'SAMPLE MODEL' ? 2 : 1, p.palette.length - 1);
  refineEdges.checked = true;
  const savedTool = context?.tool === 'Height Band' ? 'Band' : context?.tool;
  tool = typeof savedTool === 'string' && Object.hasOwn(hints, savedTool) ? savedTool : 'Brush';
  bandPending = tool === 'Band' && bounds?.pending === true;
  if (bandPending && Number.isFinite(bounds.lower) && bandUpper.value === '') bandStart = bounds.lower;
  stampIndex = tool === 'Stamps' && Number.isInteger(context?.stampIndex) &&
    context.stampIndex >= 0 && context.stampIndex < p.stamps.length ? context.stampIndex : -1;
  armed = tool === 'Text' || stampIndex >= 0;
  fillJobs?.close();
  fillJobs = null;
  v.setProject(p, prepared);
  if (tool === 'Fill Gaps') refreshGaps();
  if (tool === 'Fill') prepareFill().catch(() => {});
  $('projection').textContent = v.camera.isOrthographicCamera ? 'Orthographic' : 'Perspective';
  $('model-kind').textContent = kind;
  setDocumentName(documentName, kind === 'PAINTER PROJECT');
  ['X', 'Y', 'Z'].forEach((axis, i) => {
    $('dimensions').querySelector('.axis-' + axis).textContent = Number(v.box.size[i].toFixed(2));
  });
  $('faces').textContent = p.depth.length.toLocaleString() + ' source triangles';
  updatePaintTriangleCount();
  paletteUI();
  stampUI();
  toolUI();
  state();
  notify('Ready');
  refreshColorLimit();
}
async function task(message, fn) {
  if (busy) return false;
  stopFillAngleRepeat();
  busy = true;
  clearFillHover();
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
    scheduleFillHover();
  }
}
async function write(kind) {
  finishStroke();
  const exported = kind === 'export';
  if (!(await files.chooseWrite(kind, p.name))) return false;
  const data = {
    name: p.name, vertices: p.vertices, faces: p.faces, depth: p.depth,
    paint: p.paint, splits: p.splits, palette: p.palette, mixes: p.mixes,
  };
  if (!exported) {
    data.stamps = p.stamps;
    data.editingContext = {
      camera: v.cameraState(),
      tool,
      ...(tool === 'Fill Gaps' && gapWidth.valueAsNumber > 0 && { gapWidth: gapWidth.valueAsNumber }),
      ...(tool === 'Fill Gaps' && gapSeams.checked && { gapSeams: true }),
      ...(tool === 'Band' && { bandBounds: {
        axis: Number(bandDirection.value),
        lower: Number.isFinite(bandLower.valueAsNumber) ? bandLower.valueAsNumber : null,
        upper: Number.isFinite(bandUpper.valueAsNumber) ? bandUpper.valueAsNumber : null,
        pending: bandPending,
      } }),
      color: p.palette[selected],
      ...(p.lockedSlots.size && { lockedSlots: [...p.lockedSlots] }),
      sizes: Object.fromEntries(Object.entries(sizes).map(([name, size]) => [name, size.settings()])),
      ...(tool === 'Stamps' && { stampIndex }),
    };
  }
  const name = await files.write(data);
  if (!name) return false;
  if (!exported) {
    saved = revision;
    $('model-kind').textContent = 'PAINTER PROJECT';
    setDocumentName(name, true);
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
function openModel(selectFile) {
  return task('Opening model…', async () => {
    const file = await selectFile();
    if (!file) return;
    const project = /\.stlp$/i.test(file.name);
    const declared = project ? 0 : binarySTLFaceCount(file.bytes);
    checkFaceLimit(declared);
    if (declared > LARGE_MODEL_FACES && !(await files.confirmLargeModel(declared))) return;
    let next = await modelJob({ project, bytes: file.bytes, name: file.name }, [file.bytes.buffer]);
    const faces = next.depth.length;
    if (!declared && faces > LARGE_MODEL_FACES && !(await files.confirmLargeModel(faces))) return;
    const decision = await prepareToLeave();
    if (decision === 'cancel') return;
    // Saving may have replaced the selected project, including via a Save As dialog.
    if (project && decision === 'saved') {
      const bytes = await files.readPendingProject();
      next = await modelJob({ project: true, bytes }, [bytes.buffer]);
      if (next.depth.length > LARGE_MODEL_FACES && next.depth.length !== faces &&
          !(await files.confirmLargeModel(next.depth.length))) return;
    }
    if (!project && p) {
      next.palette = p.palette.slice();
      if (p.mixes) next.mixes = structuredClone(p.mixes);
      next.editingContext = { color: p.palette[selected] };
    }
    const { vertices, faces: indices, depth, paint, splits, palette } = next;
    const attributes = [vertices, indices, depth, paint, splits].filter(Boolean);
    const { mesh, prepared } = await modelJob({ mesh: { vertices, faces: indices, depth, paint, splits, palette } },
      [...new Set(attributes.map(a => a.buffer))]);
    Object.assign(next, mesh);
    if (file.sample) {
      load(next, 'SAMPLE MODEL', next.name, prepared);
    } else {
      load(next, project ? 'PAINTER PROJECT' : 'STL MODEL', project ? file.name : next.name, prepared);
      await files.accept();
    }
  });
}
$('open').onclick = () => openModel(files.open);
$('save').onclick = () => task('Saving project…', () => write('save'));
$('save-as').onclick = () => task('Saving project as…', () => write('saveAs'));
$('save-palette').onclick = () => task('Saving palette…', async () => {
  const data = writePalette(p);
  if (!await files.chooseWrite('palette', p.name)) return;
  const name = await files.write(data);
  notify('Saved palette ' + name);
});
$('load-palette').onclick = () => task('Loading palette…', async () => {
  const file = await files.openPalette();
  if (!file) return;
  const next = readPalette(file.text);
  if (writePalette(next) === writePalette(p)) {
    notify('Already using the colors in ' + file.name);
    return;
  }
  replacePalette('Loaded palette ' + file.name, next.palette, next.mixes, paletteMapping(p.palette, next.palette));
});
$('export').onclick = () => task('Preparing 3MF export…', () => write('export'));
files.onClose(() => task('Closing project…', async () => (await prepareToLeave()) !== 'cancel'));
$('undo').onclick = () => undo();
$('redo').onclick = () => undo(true);
$('clear-paint').onclick = () => {
  cancelBand();
  finishStroke();
  armed = draggingArtwork = false;
  clearPreview();
  $('apply').disabled = true;
  const locks = new Set(p.lockedSlots);
  if (!p.paint.some(color => color !== 0 && !locks.has(color))) {
    notify(locks.size ? 'No unlocked paint to clear.' : 'The model already uses only the base color.');
    return;
  }
  const before = p.paint.slice();
  const change = forward => {
    if (!forward) p.paint.set(before);
    else if (!locks.size) p.paint.fill(0);
    else for (let i = 0; i < before.length; i++) if (!locks.has(before[i])) p.paint[i] = 0;
    v.refreshPalette();
  };
  change(true);
  record(locks.size ? 'Cleared unlocked paint to the base color' : 'Cleared all paint to the base color', change, before.byteLength);
};
for (const b of all('[data-tool]')) b.onclick = () => chooseTool(b.dataset.tool);
$('add-color').onclick = () => {
  revealPanel('palette');
  const physical = physicalSlots(p);
  if (physical.length >= MAX_FILAMENTS || p.palette.length >= MAX_SWATCHES) return;
  const oldIndex = selected, hex = suggestFilament(p);
  const change = (forward) => {
    if (forward) {
      p.palette.push(hex);
      selected = p.palette.length - 1;
    } else {
      p.palette.pop();
      selected = oldIndex;
    }
    v.updateColorLookup();
  };
  clearPreview();
  change(true);
  record('Added palette color', change, 0, 'palette');
  paletteUI();
  schedulePreview();
};
$('add-mix').onclick = () => editMix();
function editMix(id) {
  chooseMix(p, id, parts => {
    const slot = id ?? p.palette.length, old = p.mixes?.[slot], previous = selected;
    const before = p.mixes ?? {}, after = { ...before, [slot]: parts };
    const change = forward => {
      p.mixes = forward ? after : before;
      if (forward || old) p.palette[slot] = mixHex(p.palette, forward ? parts : old);
      else p.palette.pop();
      selected = forward ? slot : previous;
      if (old) v.refreshPalette();
      else v.updateColorLookup();
    };
    clearPreview();
    change(true);
    record(old ? 'Edited mixed color' : 'Added mixed color', change, 0, 'palette');
    revealPanel('mixed-colors');
    paletteUI();
    stampUI();
    schedulePreview();
  });
}
function requestColorRemoval(id) {
  finishStroke();
  if (p.palette.length <= 1) return;
  const dependent = Object.keys(p.mixes ?? {}).map(Number).filter(slot => p.mixes[slot].some(part => part.slot === id));
  if (!dependent.length && id !== 0 && !p.paint.includes(id) && !p.stamps.some((stamp) => stamp.pixels.includes(id))) {
    removePaletteColor(id, 0);
    return;
  }
  const dialog = $('remove-color-dialog');
  const options = $('replacement-color');
  options.replaceChildren();
  p.palette.forEach((hex, i) => {
    if (i !== id && !dependent.includes(i) && !(id === 0 && p.mixes?.[i]))
      options.add(new Option(`${swatchName(i)}${i === 0 ? ' (base)' : ''} · ${hex}`, String(i)));
  });
  $('remove-color-title').textContent = 'Remove ' + swatchName(id) + '?';
  $('remove-color-description').textContent = id === 0
    ? 'Choose the new base color. It will also replace this color on painted surfaces and in saved stamps.'
    : 'This color is in use. Choose its replacement for painted surfaces and saved stamps.';
  if (dependent.length) $('remove-color-description').textContent +=
    ' These mixes will also be removed and their paint replaced: ' + dependent.map(swatchName).join(', ') + '.';
  dialog.returnValue = '';
  dialog.onclose = () => {
    if (dialog.returnValue === 'remove') removePaletteColor(id, Number(options.value), dependent);
  };
  dialog.showModal();
}

function removePaletteColor(id, replacement, dependent = []) {
  if (p.palette.length <= 1 || id === replacement) return;
  const name = swatchName(id);
  const original = p.palette;
  const removed = new Set([id, ...dependent]);
  const kept = original.map((_, index) => index).filter(index => !removed.has(index));
  if (id === 0) {
    kept.splice(kept.indexOf(replacement), 1);
    kept.unshift(replacement);
  }
  const remaining = kept.map((index) => original[index]);
  const slots = original.map((_, index) => kept.indexOf(removed.has(index) ? replacement : index));
  const beforeMixes = p.mixes ?? {}, afterMixes = {};
  for (const index of kept) {
    if (beforeMixes[index]) afterMixes[slots[index]] = beforeMixes[index].map(part => ({ ...part, slot: slots[part.slot] }));
  }
  replacePalette('Removed ' + name, remaining, afterMixes, slots);
  document.querySelector('.swatch-row [aria-pressed="true"]')?.focus({ preventScroll: true });
}

function replacePalette(label, remaining, afterMixes, slots) {
  const original = p.palette.slice(), beforeMixes = p.mixes ?? {}, previousSelection = selected;
  const beforeLocks = p.lockedSlots;
  const afterLocks = new Set([...beforeLocks].map(i => remaining.indexOf(original[i])).filter(i => i >= 0));
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
    p.mixes = forward ? afterMixes : beforeMixes;
    p.lockedSlots = forward ? afterLocks : beforeLocks;
    for (const { owner, key, before, after } of updates) owner[key] = forward ? after : before;
    selected = forward ? remap(previousSelection) : previousSelection;
    v.refreshPalette();
  };
  clearPreview();
  change(true);
  record(label, change, weight, 'palette');
  paletteUI();
  stampUI();
  schedulePreview();
}

function editPaletteColor(id, next) {
  const prev = p.palette[id];
  if (prev.toUpperCase() === next) return;
  const original = p.palette.slice(), updated = original.slice();
  updated[id] = next;
  for (const [slot, parts] of Object.entries(p.mixes ?? {})) {
    if (parts.some(part => part.slot === id)) updated[slot] = mixHex(updated, parts);
  }
  if (new Set(updated).size !== updated.length) {
    notify('This edit would create duplicate colors. Choose a different color.');
    paletteUI();
    return;
  }
  const change = (forward) => {
    p.palette = (forward ? updated : original).slice();
    v.refreshPalette();
  };
  clearPreview();
  change(true);
  record('Changed ' + swatchName(id), change, 0, 'palette');
  paletteUI();
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
let brushCursorPosition = null;
function refreshBrushCursor() {
  if (!brushCursorPosition || $('pointer').hidden) return;
  const diameter = sizes.brush.pixelsAt(brushCursorPosition);
  $('pointer').style.width = $('pointer').style.height = diameter + 'px';
}
function sizeControl(name, outputId) {
  const slider = $(name + '-size'), number = $(name + '-mm'), unit = $(name + '-unit');
  const output = $(outputId), label = output.closest('label');
  const validMillimeters = value => Number.isFinite(value) && value > 0 && value <= 1e12;
  let millimeters = number.valueAsNumber;
  function display() {
    const physical = unit.value === 'mm';
    slider.hidden = physical;
    number.hidden = !physical;
    output.hidden = physical;
    output.textContent = slider.value + ' px';
    label.htmlFor = physical ? number.id : slider.id;
  }
  function changed() {
    display();
    if (name === 'brush') refreshBrushCursor();
    else if (placingArtwork()) armPreview();
  }
  unit.onchange = slider.oninput = changed;
  number.oninput = () => {
    if (validMillimeters(number.valueAsNumber)) {
      millimeters = number.valueAsNumber;
      changed();
    }
  };
  number.onblur = () => {
    if (number.valueAsNumber !== millimeters)
      notify('Kept the last valid size of ' + millimeters + ' mm.');
    number.value = millimeters;
  };
  display();
  return {
    get physical() { return unit.value === 'mm'; },
    pixelsAt(point) {
      return this.physical ? millimeters * v.pixelsPerMillimeter(point) : +slider.value;
    },
    step(direction) {
      if (this.physical) {
        const next = Number((millimeters + direction * 0.1).toPrecision(12));
        if (!validMillimeters(next)) return;
        number.value = next;
        number.oninput();
      } else {
        slider.value = +slider.value + direction * 2;
        changed();
      }
    },
    settings() { return { unit: unit.value, mm: millimeters, px: +slider.value }; },
    restore(settings) {
      if (!settings || !['mm', 'px'].includes(settings.unit)) return;
      unit.value = settings.unit;
      if (validMillimeters(settings.mm)) {
        millimeters = settings.mm;
        number.value = millimeters;
      }
      if (Number.isFinite(settings.px)) slider.value = settings.px;
      display();
    },
  };
}
const sizes = {
  brush: sizeControl('brush', 'brush-value'),
  text: sizeControl('text', 'text-size-value'),
  stamp: sizeControl('stamp', 'stamp-size-value'),
};
const stampSlider = $('stamp-size');
stampSlider.addEventListener('pointerdown', e => {
  if (e.isPrimary && e.button === 0) stampSizePointer = e.pointerId;
});
function finishStampResize(e) {
  if (stampSizePointer === null || (e.pointerId !== undefined && e.pointerId !== stampSizePointer)) return;
  stampSizePointer = null;
  if (stampPreviewDeferred) {
    stampPreviewDeferred = false;
    schedulePreview();
  }
}
window.addEventListener('pointerup', finishStampResize, true);
window.addEventListener('pointercancel', finishStampResize, true);
stampSlider.addEventListener('lostpointercapture', finishStampResize);
window.addEventListener('blur', finishStampResize);
const refineEdges = $('refine-edges');
let lasso = null;
const lassoOutline = $('lasso-outline'), lassoLine = $('lasso-curve');
const lassoGuide = $('lasso-guide'), lassoNodes = lassoOutline.querySelector('g');
function lockLassoView(locked) {
  v.controls.enabled = !locked;
  $('view-cube').toggleAttribute('inert', locked);
  for (const id of ['view', 'align-face', 'projection', 'fit']) $(id).disabled = locked;
}
function cancelLasso() {
  if (!lasso) return;
  v.clearPaintPreview();
  lasso = null;
  lassoLine.removeAttribute('d');
  lassoNodes.replaceChildren();
  lassoGuide.removeAttribute('d');
  lockLassoView(false);
  $('apply-lasso').disabled = true;
}
function nearLassoStart(pt) {
  const first = lasso.points[0];
  return lasso.points.length >= 3 && Math.hypot(first.x - pt.x, first.y - pt.y) <= 7;
}
function removeLastLassoNode() {
  if (lasso.points.length === 1) {
    cancelLasso();
    notify('Lasso cleared. Click to start again.');
    return;
  }
  if (lasso.closed) {
    v.clearPaintPreview();
    lasso.closed = false;
    lasso.edits = null;
    $('apply-lasso').disabled = true;
  }
  lasso.points.pop();
  lassoNodes.lastElementChild.remove();
  drawLasso(v.canvas.matches(':hover') ? brushCursorPosition : null);
  notify('Last lasso node removed.');
}
function drawLasso(hover) {
  const nodes = lasso.points, first = nodes[0], last = nodes.at(-1);
  const guide = hover && (hover.x !== last.x || hover.y !== last.y);
  const closed = lasso.closed || (guide && nearLassoStart(hover));
  const points = guide && !closed ? [...nodes, hover] : nodes;
  const segments = lassoSegments(points, closed);
  if (guide) {
    lassoGuide.setAttribute('d', 'M ' + last.x + ' ' + last.y + ' ' + segments.pop());
  } else lassoGuide.removeAttribute('d');
  lassoLine.setAttribute('d', ['M', first.x, first.y, ...segments, lasso.closed ? 'Z' : ''].join(' ').trim());
}
function placeLassoNode(pt) {
  if (lasso?.closed) return;
  if (!lasso) {
    lasso = { points: [], closed: false };
    lockLassoView(true);
  }
  if (nearLassoStart(pt)) {
    lasso.closed = true;
  } else {
    if (lasso.points.some(p => p.x === pt.x && p.y === pt.y)) return;
    lasso.points.push(pt);
    const node = document.createElementNS(lassoOutline.namespaceURI, 'circle');
    node.setAttribute('cx', pt.x);
    node.setAttribute('cy', pt.y);
    node.setAttribute('r', lasso.points.length === 1 ? 5 : 3);
    lassoNodes.append(node);
  }
  drawLasso();
  if (lasso.closed) previewLasso();
}
function previewLasso() {
  try {
    v.clearPaintPreview();
    const footprint = lassoFootprint(lassoLine.getAttribute('d'), lassoLine.getBBox(), v.w, v.h, selected);
    if (footprint && refineEdges.checked) {
      const refiner = new RefinedStroke(v);
      refiner.projectFootprint(footprint);
      lasso.edits = refiner.edits;
      lasso.limited = refiner.limited;
    } else {
      lasso.edits = footprint && v.lassoCells(footprint);
      lasso.limited = false;
    }
    if (!lasso.edits?.size) {
      $('apply-lasso').disabled = true;
      notify('No visible paint would change. Choose another color or press Esc to cancel.');
      return;
    }
    v.previewPaint(lasso.edits);
    $('apply-lasso').disabled = false;
    notify('Lasso preview · Apply to paint or press Esc to cancel.');
  } catch (err) {
    cancelLasso();
    error(err);
  }
}
refineEdges.addEventListener('change', () => { if (lasso?.closed) previewLasso(); });
$('apply-lasso').onclick = () => {
  if (!lasso?.edits?.size) return;
  const { edits, limited } = lasso;
  cancelLasso();
  refreshColorLimit.beforeStroke();
  commitLeafEdits(edits, limited ? 'Filled lasso (detail limit reached)' : 'Filled lasso');
};
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
range('angle', 'angle-value', '°');
$('angle').addEventListener('input', refreshFillHover);
$('protect').addEventListener('change', refreshFillHover);
range('rotation', 'rotation-value', '°', true);
range('cutoff', 'cutoff-value', '°', true);
$('filter').onchange = () => {
  $('cutoff-wrap').hidden = !$('filter').checked;
  armed = true;
  schedulePreview();
};
$('help').onclick = () => $('guide').showModal();
function setFacePicking(active) {
  pickingFace = active;
  refreshFillHover();
  $('align-face').setAttribute('aria-pressed', String(active));
  $('pointer').hidden = true;
  notify(active ? 'Click a model face to align the camera. Esc cancels.' : 'Ready');
}
$('align-face').onclick = () => setFacePicking(!pickingFace);
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
    $('limit').value = 3;
    $('mapping-mode').value = 'existing';
    $('stamp-opacity').value = $('stamp-opacity').defaultValue;
    const physical = physicalSlots(p);
    $('mapping-mode').options[1].disabled = physical.length >= MAX_FILAMENTS || p.palette.length >= MAX_SWATCHES;
    $('mapping-mode').options[2].disabled = physical.length < 2 || p.palette.length >= MAX_SWATCHES;
    $('image-name').textContent = art.name;
    $('show-removed').checked = false;
    $('mapping-preview').replaceChildren();
    const worker = matchingWorker = new Worker('./matching-worker.js');
    worker.onmessage = ({ data }) => {
      if (worker !== matchingWorker) return;
      matchingBusy = false;
      if (pendingMatch) return sendMatch();
      if (data.error) return failMatching(data.error);
      conversion = data.result;
      showConversion();
    };
    worker.onerror = event => {
      if (worker === matchingWorker) failMatching(event.message || 'Image matching failed.');
    };
    matchingWorker.postMessage({ image: art.data, project: { palette: p.palette, mixes: p.mixes } });
    convert();
    $('mapping').showModal();
    importPreview.fit();
  });
};
let matchingWorker, pendingMatch, matchingBusy = false;
function failMatching(message) {
  $('mapping').close('cancel');
  error(Error(message));
}
function sendMatch() {
  if (matchingBusy || !pendingMatch) return;
  matchingBusy = true;
  matchingWorker.postMessage(pendingMatch);
  pendingMatch = null;
}
function convert() {
  const mode = $('mapping-mode').value;
  const physical = physicalSlots(p);
  const capacity = Math.min(MAX_SWATCHES - p.palette.length,
    mode === 'mix' ? MAX_SWATCHES : MAX_FILAMENTS - physical.length);
  $('limit').max = Math.max(1, capacity);
  $('limit-row').hidden = mode === 'existing';
  $('limit-value').textContent = $('limit').value;
  const cutoff = +$('stamp-opacity').value;
  $('stamp-opacity-value').textContent = cutoff + '%';
  $('stamp-opacity').setAttribute('aria-valuetext', cutoff + '%');
  pendingMatch = { mode, limit: mode === 'existing' ? 0 : +$('limit').value, cutoff, capacity };
  $('mapping-preview').setAttribute('aria-busy', 'true');
  $('confirm-import').disabled = true;
  $('empty-mask').hidden = true;
  $('mapped-colors').replaceChildren();
  sendMatch();
}
function showConversion() {
  $('mapping-preview').setAttribute('aria-busy', 'false');
  const physical = physicalSlots(p);
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
    const recipe = p.mixes?.[i] ?? conversion.recipes?.[i - p.palette.length];
    sw.title = recipe ? recipeLabel(recipe, physical) : palette[i];
    if (i >= p.palette.length) sw.title += ' (new)';
    $('mapped-colors').append(sw);
  }
}
function renderImportPreview() {
  if (!art || !conversion) return;
  const stamp = { ...art, pixels: conversion.pixels };
  importPreview.show(stampCanvas(stamp, [...p.palette, ...conversion.added], $('show-removed').checked));
}
$('show-removed').onchange = renderImportPreview;
$('mapping-mode').onchange = convert;
$('limit').oninput = convert;
$('stamp-opacity').oninput = convert;
$('mapping').onclose = () => {
  matchingWorker?.terminate();
  matchingWorker = pendingMatch = null;
  matchingBusy = false;
  if ($('mapping').returnValue === 'import' && art && !$('confirm-import').disabled) {
    clearPreview();
    const { data, ...stamp } = art;
    stamp.pixels = conversion.pixels;
    const added = conversion.added,
      prior = stampIndex;
    const beforeMixes = p.mixes ?? {}, afterMixes = { ...beforeMixes };
    conversion.recipes?.forEach((parts, i) => { afterMixes[p.palette.length + i] = parts; });
    const change = (forward) => {
      p.mixes = forward ? afterMixes : beforeMixes;
      if (forward) {
        p.palette.push(...added);
        p.stamps.push(stamp);
        stampIndex = p.stamps.length - 1;
      } else {
        p.palette.splice(p.palette.length - added.length, added.length);
        p.stamps.pop();
        stampIndex = prior;
      }
      v.updateColorLookup();
    };
    change(true);
    record('Imported stamp', change, stamp.source.length + stamp.pixels.length, added.length ? 'palette' : 'library');
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
  if (draggingArtwork || stampSizePointer !== null) return;
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
  function sampleMode(active) {
    if (samplingColor === active || (active && pointerId !== null)) return;
    samplingColor = active;
    if (tool === 'Fill Gaps') renderGaps();
    v.host.classList.toggle('sampling-color', active);
    if (placingArtwork() && armed) {
      if (active) updatePreview();
      else schedulePreview();
    }
    if (tool === 'Band') updateBand();
    refreshFillHover();
  }
  window.addEventListener('keydown', e => {
    if (e.key === 'Alt' && !busy && !document.querySelector('dialog[open]')) sampleMode(true);
  });
  window.addEventListener('keyup', e => {
    if (e.key === 'Alt') sampleMode(false);
  });
  function cursor(pos) {
    const el = $('pointer');
    brushCursorPosition = pos;
    el.hidden = pickingFace || !['Brush', 'Eraser'].includes(tool);
    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';
    refreshBrushCursor();
  }
  function dab(a, b) {
    const radius = sizes.brush.pixelsAt(b) / 2;
    if (stroke.refiner) {
      stroke.refiner.dab(a, b, radius);
      state();
      return;
    }
    v.stroke(a, b, radius, (id) =>
      setColor(id, tool === 'Eraser' ? 0 : selected)
    );
    v.recolor();
    state();
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (busy || pointerId !== null) return;
    if (e.button !== 0) {
      fillPoint = null;
      clearFillHover();
      $('pointer').hidden = true;
      return;
    }
    canvas.focus({ preventScroll: true });
    const pt = point(e);
    sampleMode(e.altKey);
    if (e.altKey) {
      e.preventDefault();
      const id = v.pick(pt.x, pt.y);
      if (id >= 0) {
        const slot = p.paint[id];
        revealPanel(p.mixes?.[slot] ? 'mixed-colors' : 'palette');
        selectSwatch(slot);
        notify('Picked ' + swatchName(slot) + ' · ' + p.palette[slot]);
      }
      return;
    }
    if (pickingFace) {
      if (v.alignToFace(pt)) {
        setFacePicking(false);
        notify('View aligned to face');
      } else notify('Click a face on the model. Esc cancels.');
      return;
    }
    if (tool === 'Stamps' && stampIndex < 0) return;
    if (tool === 'Fill Gaps') return;
    if (tool === 'Fill Lasso') {
      if (e.isPrimary) placeLassoNode(pt);
      return;
    }
    if (tool === 'Band') {
      pickBandBound(v.bandPositionAt(pt, Number(bandDirection.value)));
      return;
    }
    pointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'Fill') {
      const seed = fillSeed(pt), cached = fillPreview.mask;
      clearFillHover();
      if (seed < 0) return;
      if (cached?.[seed]) applyFill(cached);
      else task('Preparing fill…', async () => applyFill(await findFillRegion(seed)));
    } else if (placingArtwork()) {
      draggingArtwork = true;
      $('apply').disabled = true;
      anchor = pt;
      armed = true;
      schedulePreview();
    } else {
      last = pt;
      refreshColorLimit.beforeStroke();
      stroke = { old: new Map(), label: tool === 'Brush' ? 'Painted stroke' : 'Erased stroke' };
      if (refineEdges.checked)
        stroke.refiner = new RefinedStroke(v, tool === 'Eraser' ? 0 : selected);
      dab(pt, pt);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const pt = point(e);
    fillPoint = !e.buttons && e.pointerType !== 'touch' ? pt : null;
    if (busy) return;
    sampleMode(e.altKey);
    if (bandStart !== null && !e.buttons && !e.altKey && !pickingFace) {
      const position = v.bandPositionAt(pt, Number(bandDirection.value));
      if (bandHover !== position) {
        bandHover = position;
        updateBand();
      }
    }
    scheduleFillHover();
    if (e.buttons && !(e.buttons & 1)) {
      return;
    }
    cursor(pt);
    if (lasso && !lasso.closed) {
      drawLasso(pt);
      return;
    }
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
    if (e.type === 'pointerup' && !e.buttons && e.pointerType !== 'touch' && canvas.matches(':hover')) {
      fillPoint = point(e);
      scheduleFillHover();
    }
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
    if (lasso && !lasso.closed) drawLasso();
    fillPoint = null;
    clearFillHover();
    $('pointer').hidden = true;
  });
  window.addEventListener('blur', e => {
    sampleMode(false);
    fillPoint = null;
    clearFillHover();
    end(e);
  });
}
let heldFillKey = null, fillRepeatTimer;
function stopFillAngleRepeat() {
  clearTimeout(fillRepeatTimer);
  heldFillKey = null;
}
function startFillAngleRepeat(e) {
  if (e.repeat) return;
  stopFillAngleRepeat();
  heldFillKey = e.code || e.key;
  const angle = $('angle'), decrease = e.key === '[';
  function step(delay) {
    const previous = angle.value;
    if (decrease) angle.stepDown();
    else angle.stepUp();
    if (angle.value === previous) {
      stopFillAngleRepeat();
      return;
    }
    angle.dispatchEvent(new Event('input', { bubbles: true }));
    fillRepeatTimer = setTimeout(() => step(125), delay);
  }
  step(400);
}
window.addEventListener('keyup', e => {
  if ((e.code || e.key) === heldFillKey) stopFillAngleRepeat();
}, true);
window.addEventListener('blur', stopFillAngleRepeat);
document.addEventListener('focusin', stopFillAngleRepeat);
document.addEventListener('visibilitychange', stopFillAngleRepeat);
const applyButtonByTool = { Band: 'apply-band', 'Fill Gaps': 'apply-gaps', 'Fill Lasso': 'apply-lasso', Stamps: 'apply', Text: 'apply' };
window.addEventListener('keydown', (e) => {
  if (heldFillKey && (e.code || e.key) !== heldFillKey && !e.repeat) stopFillAngleRepeat();
  if (busy || e.isComposing || document.querySelector('dialog[open], :popover-open')) return;
  const k = e.key.toLowerCase(),
    ctrl = e.ctrlKey || e.metaKey;
  if (k === 'enter' && !ctrl && !e.altKey && !e.shiftKey && !e.defaultPrevented) {
    const apply = $(applyButtonByTool[tool]);
    if (!apply || e.target.isContentEditable ||
        e.target.matches('textarea, select, input:not([type=number],[type=range],[type=checkbox])')) return;
    const button = e.target.closest('button');
    if (button && button !== apply && !button.matches('[aria-pressed="true"][data-tool], [aria-pressed="true"][data-swatch], .stamp-choice[aria-pressed="true"]')) return;
    e.preventDefault();
    if (e.repeat) return;
    if (placingArtwork() && previewFrame && !draggingArtwork) updatePreview();
    apply.click();
    return;
  }
  if (k === 'backspace' && lasso && !ctrl && !e.altKey && !e.shiftKey && !e.defaultPrevented &&
      !e.target.isContentEditable && !e.target.matches('textarea, select, input:not([type=checkbox],[type=range])')) {
    e.preventDefault();
    if (!e.repeat) removeLastLassoNode();
    return;
  }
  if (k === 'escape' && pickingFace) {
    e.preventDefault();
    setFacePicking(false);
    v.canvas.focus({ preventScroll: true });
    return;
  }
  if (k === 'escape' && lasso) {
    e.preventDefault();
    cancelLasso();
    notify('Lasso canceled');
    v.canvas.focus({ preventScroll: true });
    return;
  }
  if (k === 'escape' && (placingArtwork() || tool === 'Fill Gaps')) {
    e.preventDefault();
    if (tool === 'Stamps') anchor = null;
    chooseTool('Brush');
    v.canvas.focus({ preventScroll: true });
    return;
  }
  if (tool === 'Band' && bandPending && k === 'escape') {
    e.preventDefault();
    cancelBand();
    v.canvas.focus({ preventScroll: true });
    return;
  }
  if (e.target.matches('textarea, input[type=number]') && !(ctrl && ['s', 'o'].includes(k))) return;
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
  if (tool === 'Fill' && !e.altKey && (k === '[' || k === ']') &&
      !e.target.isContentEditable && !e.target.matches('input:not([type=range],[type=checkbox])')) {
    e.preventDefault();
    startFillAngleRepeat(e);
    return;
  }
  if (e.target.matches('input,select') && !e.target.matches('input[type=range]')) return;
  if (/^[0-9]$/.test(k) && !e.altKey && !e.shiftKey && !e.target.isContentEditable && !e.defaultPrevented) {
    const button = document.querySelector(`[data-swatch][aria-keyshortcuts="${k}"]`);
    if (button && !e.repeat) {
      e.preventDefault();
      revealPanel(button.closest('#palette, #mixed-colors').id);
      button.scrollIntoView({block: 'nearest', container: 'nearest'});
      button.click();
    }
    return;
  }
  if (toolByKey.has(k)) {
    e.preventDefault();
    chooseTool(toolByKey.get(k));
    if (tool !== 'Text') v.canvas.focus({ preventScroll: true });
  }
  if (k === 'home') {
    e.preventDefault();
    $('fit').click();
  }
  if (tool !== 'Fill' && (k === '[' || k === ']')) {
    sizes.brush.step(k === '[' ? -1 : 1);
  }
});
async function start() {
  v = new Viewport($('viewport'), (view) => {
    cancelLasso();
    refreshFillHover();
    if (tool === 'Fill Gaps') renderGaps();
    $('view').value = view;
    refreshBrushCursor();
    schedulePreview();
  });
  await openModel(files.openLaunchFile);
  if (!p) await openModel(files.openSample);
  bindCanvas();
}
start().catch((err) => {
  error(err);
  notify('The 3D workspace could not start.');
});
