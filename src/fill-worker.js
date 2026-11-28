import { FillIndex } from './fill-index.js';
import { flood } from './mesh.js';
import { findGaps } from './fill-gaps.js';

import { seamPairs } from './seam-geometry.js';
let index, surface = {}, paint, positions, blocked, seamData, splits = [];
self.onmessage = ({ data }) => {
  const { id, mesh, ranges, changes } = data;
  try {
    if (ranges) {
      positions = undefined;
      if (mesh) {
        index = new FillIndex(mesh, ranges);
        surface.normals = data.normals;
      }
      surface.owners = data.owners;
      surface.graph = index.update(ranges, changes);
      for (const change of changes) splits[change.index] = change.splits;
      blocked = null;
      seamData = data.seams?.length ? {seams:data.seams,ranges} : null;
      self.postMessage({ id });
    } else if (data.gapPaint) {
      positions = data.positions ?? positions;
      const result = findGaps(data.gapPaint, data.lockedSlots, surface.graph, positions, data.threshold,
        data.includeSeams, progress => self.postMessage({ id, progress }));
      self.postMessage({ id, value: result }, [result.targets.buffer]);
    } else {
      if (data.paint) paint = data.paint;
      const mask = new Uint8Array(paint.length);
      if (data.stopAtSeams && seamData && !blocked)
        blocked = seamPairs(index.mesh, seamData.seams, seamData.ranges, splits, surface.graph);
      surface.blocked = data.stopAtSeams ? blocked : null;
      flood({ paint, lockedSlots: data.lockedSlots }, surface, data.seed, data.angle, data.protect, mask);
      self.postMessage({ id, value: mask }, [mask.buffer]);
    }
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
