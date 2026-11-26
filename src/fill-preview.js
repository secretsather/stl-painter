// One region request at a time. A finished search can serve a newer pointer
// position anywhere inside the same connected component.
export class FillPreview {
  constructor(findRegion, display) {
    this.findRegion = findRegion;
    this.display = display;
    this.seed = -1;
    this.generation = 0;
  }
  clear() {
    this.seed = -1;
    this.generation++;
    if (this.mask) this.display(null);
    this.mask = null;
  }
  hover(seed) {
    this.seed = seed;
    if (this.mask?.[seed]) return;
    if (this.mask) {
      this.display(null);
      this.mask = null;
    }
    if (seed >= 0 && !this.pending) this.search();
  }
  async search() {
    const generation = this.generation, seed = this.seed;
    this.pending = true;
    try {
      const mask = await this.findRegion(seed);
      if (generation === this.generation && mask?.[this.seed]) {
        this.mask = mask;
        this.display(mask);
      }
    } catch (error) {
      // A click retries a failed preview and reports any error through the task UI.
      if (generation === this.generation) console.warn('Fill preview unavailable.', error);
    } finally {
      this.pending = false;
      if (!this.mask && this.seed >= 0 && (this.seed !== seed || generation !== this.generation)) this.search();
    }
  }
}

// Composite over the visible pick pixels so hidden faces never show through.
// Pointer movement within a region leaves this canvas and the mesh untouched.
export function drawFillPreview(canvas, view, mask, paint, selected, hex) {
  canvas.parentElement.hidden = !mask;
  if (!mask) return;
  const { w, h } = view;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(w, h), ids = view.picks().ids;
  const rgba = pixels.data;
  const rgb = parseInt(hex.slice(1), 16), r = rgb >> 16, g = rgb >> 8 & 255, b = rgb & 255;
  const outline = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? 35 : 250;
  const affected = id => id >= 0 && mask[id] && paint[id] !== selected;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!affected(ids[i])) continue;
      const edge = !x || !y || x === w - 1 || y === h - 1 || !affected(ids[i - 1]) ||
        !affected(ids[i + 1]) || !affected(ids[i - w]) || !affected(ids[i + w]);
      const offset = i * 4;
      rgba[offset] = edge ? outline : r;
      rgba[offset + 1] = edge ? outline : g;
      rgba[offset + 2] = edge ? outline : b;
      rgba[offset + 3] = edge ? 235 : 120;
    }
  }
  context.putImageData(pixels, 0, 0);
}
