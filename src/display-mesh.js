import { BufferAttribute, BufferGeometry, Color } from 'three';
import { makeSurface } from './mesh.js';

export function geometryForProject(p) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(p.vertices, 3));
  geometry.setIndex(new BufferAttribute(p.faces, 1));
  return geometry;
}

export function displayColors(palette) {
  return palette.map(hex => new Color(hex).toArray().map(value => Math.round(value * 255)));
}

export function writeColor(a, id, [r, g, b]) {
  for (let j = id * 9; j < id * 9 + 9; j += 3) {
    a[j] = r;
    a[j + 1] = g;
    a[j + 2] = b;
  }
}

export function displayChunk(project, range, normals, rgb) {
  const data = makeSurface(project, range, normals);
  const flatNormals = new Float32Array(data.positions.length);
  const colorBytes = new Uint8Array(flatNormals.length);
  const faceOffsets = new Uint32Array(range.endFace - range.face + 1);
  for (let cell = 0; cell < data.owners.length; cell++) {
    const face = data.owners[cell], n = face * 3;
    if (!cell || face !== data.owners[cell - 1]) faceOffsets[face - range.face] = cell;
    for (let j = cell * 9; j < cell * 9 + 9; j += 3) {
      flatNormals[j] = normals[n];
      flatNormals[j + 1] = normals[n + 1];
      flatNormals[j + 2] = normals[n + 2];
    }
    writeColor(colorBytes, cell, rgb[project.paint[range.cell + cell]]);
  }
  faceOffsets[faceOffsets.length - 1] = data.owners.length;
  return { data, flatNormals, colorBytes, faceOffsets };
}
