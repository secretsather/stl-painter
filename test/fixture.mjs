// A painted grid with explicit millimeter spacing and one paint cell per face.
export function gapGrid(width = 12, height = 6, spacing = 0.1) {
  const vertices = [], faces = [];
  for (let y = 0; y <= height; y++) for (let x = 0; x <= width; x++) vertices.push(x * spacing, y * spacing, 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = y * (width + 1) + x, b = a + width + 1;
    faces.push(a, a + 1, b, b, a + 1, b + 1);
  }
  return { name: 'Pinholes', vertices: Float32Array.from(vertices), faces: Uint32Array.from(faces),
    depth: new Uint8Array(faces.length / 3), paint: new Uint8Array(faces.length / 3),
    palette: ['#F0DDAA', '#772233', '#227755', '#224488'], stamps: [] };
}

// A closed beveled slab, plus a disconnected block. Z is up and coordinates are mm.
export function fixture() {
  const triangles = [];
  function solid(section, y0, y1) {
    const near = section.map(([x, z]) => [x, y0, z]),
      far = section.map(([x, z]) => [x, y1, z]);
    for (let i = 0; i < section.length; i++) {
      const j = (i + 1) % section.length;
      triangles.push([near[i], far[i], far[j]], [near[i], far[j], near[j]]);
    }
    for (let i = 1; i < section.length - 1; i++)
      triangles.push([near[0], near[i], near[i + 1]], [far[0], far[i + 1], far[i]]);
  }
  solid(
    [
      [-40, 0],
      [40, 0],
      [40, 8],
      [32, 12],
      [-40, 12],
    ],
    -26,
    26
  );
  solid(
    [
      [47, 0],
      [55, 0],
      [55, 6],
      [47, 6],
    ],
    -10,
    10
  );
  const bin = Buffer.alloc(84 + triangles.length * 50);
  bin.writeUInt32LE(triangles.length, 80);
  triangles.forEach((t, i) => t.flat().forEach((v, k) => bin.writeFloatLE(v, 96 + i * 50 + k * 4)));
  return bin;
}
