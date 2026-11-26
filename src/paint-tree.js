// Beyond the initial uniform four-way grid, each node splits the edge opposite
// its numbered vertex. The painted 3MF stores these single-edge splits in child order.
export const MAX_EDGE_DEPTH = 16;

export function bisect(a, b, c, side, midpoint) {
  if (side === 2) [a, b, c] = [b, c, a];
  else if (side === 3) [a, b, c] = [c, a, b];
  const m = midpoint(b, c);
  return [
    [a, b, m],
    [m, c, a],
  ];
}

export function walkPaintCells(p, vertex, midpoint, emit, range) {
  let node = range?.node ?? 0,
    cell = 0;
  function visit(a, b, c, uniform, extra, face) {
    if (uniform) {
      const ab = midpoint(a, b),
        bc = midpoint(b, c),
        ca = midpoint(c, a);
      visit(a, ab, ca, uniform - 1, 0, face);
      visit(ab, b, bc, uniform - 1, 0, face);
      visit(bc, c, ca, uniform - 1, 0, face);
      visit(ab, bc, ca, uniform - 1, 0, face);
    } else {
      const side = p.splits?.[node++];
      if (side) {
        for (const child of bisect(a, b, c, side, midpoint)) visit(...child, 0, extra + 1, face);
      } else emit(a, b, c, cell++, face, extra);
    }
  }
  for (let f = range?.face ?? 0; f < (range?.endFace ?? p.depth.length); f++) {
    visit(
      vertex(p.faces[3 * f]),
      vertex(p.faces[3 * f + 1]),
      vertex(p.faces[3 * f + 2]),
      p.depth[f],
      0,
      f
    );
  }
}

export function validSplits(splits, roots, leaves) {
  if (roots > leaves || splits.length !== 2 * leaves - roots) return false;
  let pos = 0;
  function consume(depth) {
    const side = splits[pos++];
    return (
      side === 0 ||
      (side >= 1 && side <= 3 && depth < MAX_EDGE_DEPTH && consume(depth + 1) && consume(depth + 1))
    );
  }
  for (let root = 0; root < roots; root++) if (!consume(0)) return false;
  return pos === splits.length;
}

// Replace only the edited leaves. Everything else retains its original split
// order and palette assignment. The previous arrays remain intact for undo.
export function surfaceRanges(project) {
  const ranges = [];
  let face = 0, cell = 0, node = 0;
  while (face < project.depth.length) {
    const range = { face, cell, node };
    let roots = 0;
    do {
      roots += 4 ** project.depth[face++];
    } while (face < project.depth.length && roots < 8192);
    let leaves = roots;
    if (project.splits) {
      for (let remaining = roots; remaining > 0; node++) {
        if (project.splits[node]) { remaining++; leaves++; }
        else remaining--;
      }
    } else node += roots;
    cell += leaves;
    ranges.push({ ...range, endFace: face, endNode: node, endCell: cell });
  }
  return ranges;
}

export function applyLeafEdits(project, edits, ranges = surfaceRanges(project)) {
  const ids = [...edits.keys()].sort((a, b) => a - b);
  function extra(tree) {
    return typeof tree === 'number' ? 0 : 1 + extra(tree.left) + extra(tree.right);
  }
  const expanded = [];
  const changed = new Set();
  let edit = 0, growth = 0;
  for (const [i, range] of ranges.entries()) {
    const cell = range.cell + growth, node = range.node + growth * 2;
    while (edit < ids.length && ids[edit] < range.endCell) {
      changed.add(i);
      growth += extra(edits.get(ids[edit++]));
    }
    expanded.push({ ...range, cell, node, endCell: range.endCell + growth, endNode: range.endNode + growth * 2 });
  }
  const paint = new Uint8Array(project.paint.length + growth);
  const old = project.splits;
  const splits = new Uint8Array((old?.length ?? project.paint.length) + 2 * growth);
  let outCell = 0, outNode = 0;
  function emit(tree) {
    if (typeof tree === 'number') {
      outNode++;
      paint[outCell++] = tree;
    } else {
      splits[outNode++] = tree.side;
      emit(tree.left);
      emit(tree.right);
    }
  }
  for (const [i, range] of ranges.entries()) {
    outCell = expanded[i].cell;
    outNode = expanded[i].node;
    if (!changed.has(i)) {
      paint.set(project.paint.subarray(range.cell, range.endCell), outCell);
      if (old) splits.set(old.subarray(range.node, range.endNode), outNode);
      continue;
    }
    let cell = range.cell;
    for (let node = range.node; node < range.endNode; node++) {
      if (old?.[node]) splits[outNode++] = old[node];
      else { emit(edits.get(cell) ?? project.paint[cell]); cell++; }
    }
  }
  return { paint, splits, ranges: expanded, changed };
}
