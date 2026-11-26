import { FillIndex } from './fill-index.js';

let index;
self.onmessage = ({ data: { id, mesh, ranges, changes } }) => {
  try {
    if (mesh) index = new FillIndex(mesh, ranges);
    const graph = index.update(ranges, changes);
    self.postMessage({ id, graph }, [graph.links.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
