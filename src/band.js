import { MAX_CELLS } from './mesh.js';
import { bisect, MAX_EDGE_DEPTH } from './paint-tree.js';

const midpoint = (a, b) => (a + b) / 2;

// Work along the selected model axis, including occluded surfaces. Only cells crossing a band
// edge need new paint leaves in the project's midpoint subdivision format.
export function bandEdits(chunks, paint, axis, low, high, color, lockedSlots) {
  const edits = new Map();
  if (!(high > low)) return edits;
  const tolerance = Math.min(0.04, (high - low) / 16);
  let remaining = MAX_CELLS - paint.length;
  function visit(a, b, c, level, old) {
    const min = Math.min(a, b, c), max = Math.max(a, b, c);
    if (min >= low && max <= high) return color;
    if (max <= low || min >= high) return old;
    if (max - min <= tolerance) {
      const center = (a + b + c) / 3;
      return center >= low && center <= high ? color : old;
    }
    if (level >= MAX_EDGE_DEPTH)
      throw Error('This band needs finer edges than this surface supports. Try a wider band or a different position.');
    const spans = [Math.abs(b - c), Math.abs(c - a), Math.abs(a - b)];
    const side = spans.indexOf(Math.max(...spans)) + 1;
    const children = bisect(a, b, c, side, midpoint);
    const left = visit(...children[0], level + 1, old);
    const right = visit(...children[1], level + 1, old);
    if (left === right) return left;
    if (--remaining < 0) throw Error('This band would exceed the project paint-cell limit.');
    return { side, left, right };
  }
  for (const { range, data } of chunks) {
    const { positions, levels } = data;
    for (let local = 0; local < levels.length; local++) {
      const id = range.cell + local, old = paint[id];
      if (old === color || lockedSlots?.has(old)) continue;
      const k = local * 9 + axis;
      const tree = visit(positions[k], positions[k + 3], positions[k + 6], levels[local], old);
      if (tree !== old) edits.set(id, tree);
    }
  }
  return edits;
}
