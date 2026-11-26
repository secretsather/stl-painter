// Each paint cell has one exported filament slot and a continuous Z extent.
export function cellHeights(positions) {
  const heights = new Float32Array((positions.length / 9) * 2);
  for (let i = 0, j = 0; i < positions.length; i += 9, j += 2) {
    const a = positions[i + 2],
      b = positions[i + 5],
      c = positions[i + 8];
    heights[j] = Math.min(a, b, c);
    heights[j + 1] = Math.max(a, b, c);
  }
  return heights;
}

function countColors(mask) {
  let n = 0;
  while (mask) {
    mask &= mask - 1;
    n++;
  }
  return n;
}

export function findColorConflict(heights, paint, limit, masks) {
  const sourceMask = slot => masks ? masks[slot] : 1 << slot;
  let used = 0;
  for (const color of paint) used |= sourceMask(color);
  if (countColors(used) <= limit) return null;

  // Union each color's occupied bands before comparing colors. A single
  // min/max per color would incorrectly bridge unpainted gaps.
  const bands = Array.from({ length: 16 }, () => new Map());
  const events = new Map();
  function event(z) {
    let e = events.get(z);
    if (!e) {
      e = { start: 0, end: 0, flat: 0 };
      events.set(z, e);
    }
    return e;
  }
  for (let i = 0; i < paint.length; i++) {
    const lo = heights[2 * i],
      hi = heights[2 * i + 1],
      color = paint[i];
    const mask = sourceMask(color);
    if (lo === hi) event(lo).flat |= mask;
    else {
      for (let bits = mask; bits; bits &= bits - 1) {
        const spans = bands[31 - Math.clz32(bits & -bits)];
        if (hi > (spans.get(lo) ?? -Infinity)) spans.set(lo, hi);
      }
    }
  }
  for (let color = 0; color < bands.length; color++) {
    const bit = 1 << color;
    let end = -Infinity;
    for (const [lo, hi] of [...bands[color]].sort((a, b) => a[0] - b[0])) {
      if (lo > end) {
        if (end !== -Infinity) event(end).end |= bit;
        event(lo).start |= bit;
      }
      end = Math.max(end, hi);
    }
    if (end !== -Infinity) event(end).end |= bit;
  }

  let above = 0,
    previous,
    worst = null,
    peak = limit;
  function check(mask, z) {
    const count = countColors(mask);
    if (count > peak) {
      peak = count;
      worst = { count, mask, z };
    }
  }
  for (const z of [...events.keys()].sort((a, b) => a - b)) {
    const { start, end, flat } = events.get(z);
    if (previous !== undefined) check(above, (previous + z) / 2);
    // At a color change, the bands above and below are separate. A flat
    // painted face can share the boundary with either neighboring band.
    if (flat) check(above | flat, z);
    above = (above & ~end) | start;
    if (flat) check(above | flat, z);
    previous = z;
  }
  return worst;
}
