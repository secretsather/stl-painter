import { FillIndex } from './fill-index.js';
import { flood } from './mesh.js';

let index, surface = {}, paint;
self.onmessage = ({ data }) => {
  const { id, mesh, ranges, changes } = data;
  try {
    if (ranges) {
      if (mesh) {
        index = new FillIndex(mesh, ranges);
        surface.normals = data.normals;
      }
      surface.owners = data.owners;
      surface.graph = index.update(ranges, changes);
      self.postMessage({ id });
    } else {
      if (data.paint) paint = data.paint;
      const mask = new Uint8Array(paint.length);
      flood({ paint }, surface, data.seed, data.angle, data.protect, mask);
      self.postMessage({ id, value: mask }, [mask.buffer]);
    }
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
