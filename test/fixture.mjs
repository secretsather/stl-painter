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
