// Use the installed font's shaped glyphs, including its overhangs and accents.
// Keep placement in screen pixels even when a large label needs a smaller mask.
export function textArtwork({ text, family, size, bold, italic, align, color }) {
  if (!text.trim()) return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const font = `${italic ? 'italic' : 'normal'} ${bold ? 'bold' : 'normal'} ${size}px ${JSON.stringify(family)}`;
  ctx.font = font;
  ctx.textAlign = align;
  const lines = text.split('\n');
  const advance = size * 1.25;
  let left = Infinity,
    right = -Infinity,
    top = Infinity,
    bottom = -Infinity;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const metrics = ctx.measureText(line);
    left = Math.min(left, -metrics.actualBoundingBoxLeft);
    right = Math.max(right, metrics.actualBoundingBoxRight);
    top = Math.min(top, i * advance - metrics.actualBoundingBoxAscent);
    bottom = Math.max(bottom, i * advance + metrics.actualBoundingBoxDescent);
  });
  if (right <= left || bottom <= top) return null;
  const w = right - left + 2,
    h = bottom - top + 2;
  const scale = Math.min(2, 4096 / Math.max(w, h), Math.sqrt(1048576 / (w * h)));
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);
  ctx.scale(scale, scale);
  ctx.font = font;
  ctx.textAlign = align;
  lines.forEach((line, i) => ctx.fillText(line, 1 - left, i * advance + 1 - top));
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = data[i * 4 + 3] >= 128 ? color : 255;
  return {
    pixels,
    width: canvas.width,
    height: canvas.height,
    placementWidth: canvas.width / scale,
  };
}

export async function loadFontFamilies(select) {
  if (!window.queryLocalFonts) return;
  try {
    const fonts = await window.queryLocalFonts();
    const families = [...new Set(fonts.map((font) => font.family))].sort((a, b) =>
      a.localeCompare(b)
    );
    if (!families.length) return;
    const selected = select.value;
    select.replaceChildren(...families.map((family) => new Option(family, family)));
    if (families.includes(selected)) select.value = selected;
  } catch {
    // The standard Windows families in the selector also work offline when
    // the system disables local font enumeration.
  }
}
