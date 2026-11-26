import { findColorConflict } from './color-at-height.js';

let heights;
self.onmessage = ({ data }) => {
  if (data.heights) heights = data.heights;
  self.postMessage(findColorConflict(heights, data.paint, data.limit, data.masks));
};
