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
      vertex(p.faces[3 * f], f, 0),
      vertex(p.faces[3 * f + 1], f, 1),
      vertex(p.faces[3 * f + 2], f, 2),
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

// Walk adaptive trees in the touched chunks. Returning a uniform slot even
// from an untouched child lets a changed ancestor collapse in a legacy tree.
// A separate root starts at every cell of the original four-way paint grid.
function siblingMerges(project, ranges, ids, edits) {
  const merges = [];
  if (!project.splits) return merges;
  const protectedRoots = project.seamRoots;
  let edit = 0, cell, node, root;
  function visit() {
    const startNode = node++, startCell = cell;
    if (!project.splits[startNode]) {
      cell++;
      if (ids[edit] !== startCell) return project.paint[startCell];
      edit++;
      const tree = edits?.get(startCell) ?? project.paint[startCell];
      // The refiner already reduces uniform branches in its replacement trees.
      return typeof tree === 'number' ? tree : -1;
    }
    const firstEdit = edit, firstMerge = merges.length;
    const left = visit(), right = visit();
    if (left < 0 || left !== right) return -1;
    if (edit !== firstEdit && !protectedRoots?.has(root)) {
      merges.length = firstMerge;
      merges.push({node: startNode, endNode: node, cell: startCell, endCell: cell, color: left});
    }
    return left;
  }
  for (const range of ranges) {
    if (edit === ids.length) break;
    if (ids[edit] >= range.endCell) continue;
    if (range.endNode - range.node === range.endCell - range.cell) {
      while (ids[edit] < range.endCell) edit++;
      continue;
    }
    node = range.node;
    cell = range.cell;
    root = 2 * range.cell - range.node;
    while (ids[edit] < range.endCell) { visit(); root++; }
  }
  return merges;
}

export function mergeRepaintedCells(project, ranges, paintedIds) {
  if (!project.splits) return null;
  let ids = paintedIds;
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] < ids[i - 1]) {
      ids = Uint32Array.from(ids).sort();
      break;
    }
  }
  const merges = siblingMerges(project, ranges, ids);
  return merges.length ? rewritePaint(project, ranges, ids, null, merges) : null;
}

// Removing or moving the last seam in a root releases its same-color
// subdivisions. Other seams and all still-visible paint boundaries survive.
export function releaseSeamRoots(project, ranges, releasedRoots) {
  if (!project.splits || !releasedRoots.size) return null;
  const cells = [], ordered = Uint32Array.from(releasedRoots).sort();
  let index = 0;
  for (const r of ranges) {
    const firstRoot = 2 * r.cell - r.node, lastRoot = 2 * r.endCell - r.endNode;
    while (index < ordered.length && ordered[index] < firstRoot) index++;
    if (index >= ordered.length) break;
    if (ordered[index] >= lastRoot) continue;
    let node = r.node, cell = r.cell;
    for (let root = firstRoot; root < lastRoot; root++) {
      const release = releasedRoots.has(root) && project.splits[node];
      for (let pending = 1; pending;) {
        if (project.splits[node++]) pending++;
        else {
          if (release) cells.push(cell);
          cell++; pending--;
        }
      }
    }
  }
  return cells.length ? mergeRepaintedCells(project, ranges, cells) : null;
}

export function applyLeafEdits(project, edits, ranges = surfaceRanges(project)) {
  const ids = Uint32Array.from(edits.keys()).sort();
  return rewritePaint(project, ranges, ids, edits, siblingMerges(project, ranges, ids, edits));
}

function rewritePaint(project, ranges, ids, edits, merges) {
  function extra(tree) {
    return typeof tree === 'number' ? 0 : 1 + extra(tree.left) + extra(tree.right);
  }
  const updatedRanges = [];
  const changed = new Set();
  let edit = 0, merge = 0, growth = 0;
  for (const [i, range] of ranges.entries()) {
    const cell = range.cell + growth, node = range.node + growth * 2;
    if (ids[edit] < range.endCell) changed.add(i);
    while (edit < ids.length && ids[edit] < range.endCell) {
      if (edits) growth += extra(edits.get(ids[edit]));
      edit++;
    }
    while (merge < merges.length && merges[merge].cell < range.endCell) {
      const removed = merges[merge++];
      growth -= removed.endCell - removed.cell - 1;
    }
    updatedRanges.push({ ...range, cell, node, endCell: range.endCell + growth, endNode: range.endNode + growth * 2 });
  }
  const paint = new Uint8Array(project.paint.length + growth);
  const old = project.splits;
  const nodeCount = (old?.length ?? project.paint.length) + 2 * growth;
  const splits = nodeCount > paint.length ? new Uint8Array(nodeCount) : undefined;
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
  merge = 0;
  for (const [i, range] of ranges.entries()) {
    outCell = updatedRanges[i].cell;
    outNode = updatedRanges[i].node;
    if (!changed.has(i)) {
      paint.set(project.paint.subarray(range.cell, range.endCell), outCell);
      if (old && splits) splits.set(old.subarray(range.node, range.endNode), outNode);
      continue;
    }
    let cell = range.cell;
    for (let node = range.node; node < range.endNode; node++) {
      const collapsed = merges[merge];
      if (collapsed?.node === node) {
        emit(collapsed.color);
        cell = collapsed.endCell;
        node = collapsed.endNode - 1;
        merge++;
      } else if (old?.[node]) splits[outNode++] = old[node];
      else { emit(edits?.get(cell) ?? project.paint[cell]); cell++; }
    }
  }
  return { paint, splits, ranges: updatedRanges, changed };
}
