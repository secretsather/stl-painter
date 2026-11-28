export function suggestedPauseHeight({lo, hi}, bottom) {
  return (lo - bottom) + (hi - lo) / 2;
}

// Round inward so a displayed range cannot extend into either color.
export function pauseWindow({lo, hi}, bottom) {
  const lower = Math.ceil((lo-bottom)*1000)/1000;
  const upper = Math.floor((hi-bottom)*1000)/1000;
  return lower < upper ? lower + '–' + upper + ' mm' :
    '≈ ' + Number((lo-bottom).toFixed(3)) + ' mm · verify layer boundary';
}

function slots(mask) {
  const result = [];
  for (; mask; mask &= mask - 1) result.push(31 - Math.clz32(mask & -mask));
  return result;
}

function sharesPause(pause, lo, hi) {
  const start = Math.max(pause.lo, lo);
  const end = Math.min(pause.hi, hi);
  if (start !== end) return start < end;
  // An exact color boundary can also fall inside another head's idle window.
  const permitsBoundary = (a, b) => a === b || (a < start && start < b);
  return permitsBoundary(pause.lo, pause.hi) && permitsBoundary(lo, hi);
}

// Orca maps each project filament to one head for the whole print. A color
// returning higher up must therefore return to that same head.
export function planToolheads(used, limit, neighbors, bands) {
  const colors = slots(used);
  if (colors.length <= limit) return { heads: colors.map(color => [color]), pauses: [] };

  // Prefer sharing with filaments that finish before the new one starts.
  // Backtrack if a locally convenient choice prevents a fixed mapping.
  const heads = [];
  const degree = neighbors.map(mask => slots(mask).length);
  function assign(remaining) {
    if (!remaining.length) return true;
    let chosen, choices;
    for (const color of remaining) {
      const available = heads.filter(head => !(neighbors[color] & head.mask));
      if (!choices || available.length < choices.length ||
          (available.length === choices.length && degree[color] > degree[chosen])) {
        chosen = color;
        choices = available;
      }
    }
    const next = remaining.filter(color => color !== chosen);
    const bit = 1 << chosen;
    if (heads.length < limit) {
      heads.push({ mask: bit });
      if (assign(next)) return true;
      heads.pop();
    }
    function interleaved(head) {
      const spans = bands[chosen];
      return slots(head.mask).filter(color =>
        spans[0][0] < bands[color].at(-1)[1] && bands[color][0][0] < spans.at(-1)[1]
      ).length;
    }
    choices.sort((a,b) => interleaved(a) - interleaved(b));
    for (const head of choices) {
      head.mask |= bit;
      if (assign(next)) return true;
      head.mask ^= bit;
    }
    return false;
  }
  if (!assign(colors)) return null;

  const swaps = [];
  const loads = heads.sort((a,b) => slots(a.mask)[0] - slots(b.mask)[0]).map(({mask}, head) => {
    const members = slots(mask);
    if (members.length === 1) return members;
    const ordered = members.flatMap(color => bands[color].map(([lo,hi]) => ({color,lo,hi})))
      .sort((a,b) => a.lo - b.lo);
    const sequence = [];
    let previous;
    for (const use of ordered) {
      if (use.color !== previous?.color) {
        if (previous) swaps.push({head, from:previous.color, to:use.color, lo:previous.hi, hi:use.lo});
        if (!sequence.includes(use.color)) sequence.push(use.color);
      }
      previous = use;
    }
    return sequence;
  });
  // Combine swaps only where all their windows intersect. Merely touching
  // windows may straddle a flat painted face that must print between pauses.
  const pauses = [];
  for (const {head,from,to,lo,hi} of swaps.sort((a,b) => a.hi-b.hi || a.lo-b.lo || a.head-b.head)) {
    let pause = pauses.at(-1);
    if (!pause || !sharesPause(pause, lo, hi) || pause.swaps.some(s => s.head === head)) {
      pause = { lo, hi, swaps: [] };
      pauses.push(pause);
    } else {
      pause.lo = Math.max(pause.lo,lo);
      pause.hi = Math.min(pause.hi,hi);
    }
    pause.swaps.push({head,from,to});
  }
  return {heads:loads, pauses};
}
