import { MeshBVH } from 'three-mesh-bvh';
import { geometryForProject, displayChunk, displayColors } from './display-mesh.js';
import { surfaceRanges } from './paint-tree.js';
import { readSTL, bounds, sourceNormals } from './mesh.js';
import { readProject } from './files.js';

self.onmessage = ({ data }) => {
  try {
    if (data.mesh) {
      const mesh = data.mesh, normals = sourceNormals(mesh), ranges = surfaceRanges(mesh);
      const rgb = displayColors(mesh.palette), box = bounds(mesh.vertices);
      const tree = MeshBVH.serialize(new MeshBVH(geometryForProject(mesh), { indirect: true }), { cloneBuffers: false });
      const chunks = ranges.map(range => displayChunk(mesh, range, normals, rgb));
      const buffers = new Set([mesh.vertices.buffer, mesh.faces.buffer, mesh.depth.buffer, mesh.paint.buffer,
        normals.buffer, tree.indirectBuffer.buffer, ...tree.roots]);
      if (mesh.splits) buffers.add(mesh.splits.buffer);
      for (const { data, colorBytes, faceOffsets, flatNormals } of chunks) {
        for (const a of [data.positions, data.owners, data.levels, colorBytes, faceOffsets, flatNormals]) buffers.add(a.buffer);
      }
      self.postMessage({ value: { mesh, prepared: { normals, ranges, tree, box, chunks } } }, [...buffers]);
      return;
    }
    const p = data.project ? readProject(data.bytes) : readSTL(data.bytes, data.name);
    const arrays = [p.vertices, p.faces, p.depth, p.paint, p.splits,
      ...p.stamps.flatMap(s => [s.pixels, s.source])].filter(Boolean);
    self.postMessage({ value: p }, [...new Set(arrays.map(a => a.buffer))]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
