// Beyond the initial uniform four-way grid, each node splits the edge opposite
// its numbered vertex. These are Orca's single-edge splits, in child order.
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

export function walkPaintCells(p, vertex, midpoint, emit) {
  let node = 0,
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
  for (let f = 0; f < p.depth.length; f++) {
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
export function applyLeafEdits(project, edits) {
  const paint = [],
    splits = [];
  let cell = 0;
  function emit(tree) {
    if (typeof tree === 'number') {
      splits.push(0);
      paint.push(tree);
    } else {
      splits.push(tree.side);
      emit(tree.left);
      emit(tree.right);
    }
  }
  const old = project.splits;
  for (let i = 0; i < (old?.length ?? project.paint.length); i++) {
    if (old?.[i]) splits.push(old[i]);
    else {
      emit(edits.get(cell) ?? project.paint[cell]);
      cell++;
    }
  }
  return { paint: Uint8Array.from(paint), splits: Uint8Array.from(splits) };
}
