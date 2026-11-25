import { validSplits } from './paint-tree.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { checkFaceLimit, MAX_CELLS } from './mesh.js';

const bytes = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const json = (a) => strToU8(JSON.stringify(a));
const validColor = (s) => typeof s === 'string' && /^#[\da-f]{6}$/i.test(s);
export function writeProject(p) {
  const files = {
    'project.json': json({
      version: p.splits ? 2 : 1,
      name: p.name,
      palette: p.palette,
      stamps: p.stamps.map(({ name, width, height }) => ({ name, width, height })),
    }),
    'vertices.f32': bytes(p.vertices),
    'faces.u32': bytes(p.faces),
    'depth.u8': p.depth,
    'paint.u8': p.paint,
  };
  if (p.splits) files['splits.u8'] = p.splits;
  p.stamps.forEach((s, i) => {
    files['stamps/' + i + '.png'] = s.source;
    files['stamps/' + i + '.idx'] = s.pixels;
  });
  return zipSync(files, { level: 4 });
}
// Older STL imports could leave vertices from discarded facets in the project.
// Preserve face and corner order because the paint tree follows that order.
function referencedVertices(vertices, faces) {
  const indices = new Uint32Array(vertices.length / 3);
  for (const index of faces) indices[index] = 1;
  let count = 0;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i]) indices[i] = ++count;
  }
  if (count === indices.length) return vertices;
  const compact = new Float32Array(count * 3);
  for (let i = 0; i < indices.length; i++) {
    if (indices[i]) compact.set(vertices.subarray(i * 3, i * 3 + 3), (indices[i] - 1) * 3);
  }
  for (let i = 0; i < faces.length; i++) faces[i] = indices[faces[i]] - 1;
  return compact;
}

export function readProject(input) {
  let total = 0;
  const files = unzipSync(input, {
    filter(entry) {
      total += entry.originalSize;
      if (total > 256 * 1024 * 1024) throw Error('This project exceeds the 256 MB unpacked limit.');
      return true;
    },
  });
  const fail = () => {
    throw Error('The painter project is incomplete or damaged.');
  };
  function get(key) {
    return files[key] || fail();
  }
  const m = JSON.parse(strFromU8(get('project.json')));
  if (m.version !== 1 && m.version !== 2)
    throw Error('This project requires a different version of STL Painter.');
  if (
    typeof m.name !== 'string' ||
    !Array.isArray(m.palette) ||
    m.palette.length < 1 ||
    m.palette.length > 16 ||
    !m.palette.every(validColor) ||
    !Array.isArray(m.stamps)
  )
    fail();
  const typed = (key, Type) => {
    const b = get(key);
    if (b.length % 4) fail();
    return new Type(b.slice().buffer);
  };
  const vertices = typed('vertices.f32', Float32Array),
    faces = typed('faces.u32', Uint32Array);
  const depth = get('depth.u8'),
    paint = get('paint.u8');
  const splits = m.version === 2 ? get('splits.u8') : undefined;
  checkFaceLimit(depth.length);
  const roots = depth.reduce((n, d) => n + 4 ** d, 0);
  if (
    vertices.length % 3 ||
    !depth.length ||
    faces.length !== depth.length * 3 ||
    vertices.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e12) ||
    faces.some((i) => i >= vertices.length / 3) ||
    depth.some((d) => d > 8) ||
    paint.length > MAX_CELLS ||
    (splits ? !validSplits(splits, roots, paint.length) : paint.length !== roots) ||
    paint.some((c) => c >= m.palette.length)
  )
    fail();
  const stamps = m.stamps.map(({ name, width, height }, i) => {
    const source = get('stamps/' + i + '.png'),
      pixels = get('stamps/' + i + '.idx');
    if (
      typeof name !== 'string' ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      Math.min(width, height) < 1 ||
      Math.max(width, height) > 512 ||
      width * height !== pixels.length ||
      pixels.some((c) => c !== 255 && c >= m.palette.length) ||
      source[0] !== 137 ||
      source[1] !== 80
    )
      fail();
    return { name, width, height, source, pixels };
  });
  return {
    name: m.name,
    vertices: referencedVertices(vertices, faces),
    faces,
    depth,
    paint,
    palette: m.palette,
    stamps,
    ...(splits && { splits }),
  };
}

function leafCode(slot) {
  if (slot <= 2) return String(slot * 4);
  return (slot - 3).toString(16).toUpperCase() + 'C';
}
function encodePaintTree(paint, cursor, depth, slots, splits) {
  let count = 4,
    splitCode = '3';
  if (!depth) {
    const side = splits?.[cursor.node++];
    if (!side) return leafCode(slots[paint[cursor.cell++]]);
    count = 2;
    splitCode = String(1 + 4 * (side - 1));
  }
  const children = Array.from({ length: count }, () =>
    encodePaintTree(paint, cursor, Math.max(0, depth - 1), slots, splits)
  );
  if (children[0].length <= 2 && children.every((s) => s === children[0])) return children[0];
  return children.join('') + splitCode;
}
export function paintTree(paint, start, count, slots) {
  return encodePaintTree(paint, { cell: start, node: 0 }, Math.log2(count) / 2, slots);
}
function xml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]
  );
}
export function writeOrca(p) {
  const used = [...new Set(p.paint)].sort((a, b) => a - b);
  const colors = used.map((i) => p.palette[i].toUpperCase());
  const slots = p.palette.map((_, i) => used.indexOf(i) + 1);
  const header = '<?xml version="1.0" encoding="UTF-8"?>';
  const segments = [
    header,
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"><metadata name="BambuStudio:3mfVersion">1</metadata><metadata name="Application">OrcaSlicer-2.3.2</metadata><metadata name="Designer">STL Painter</metadata><resources><object id="1" type="model" name="' +
      xml(p.name) +
      '"><mesh><vertices>',
  ];
  for (let i = 0; i < p.vertices.length; i += 3)
    segments.push(
      '<vertex x="' +
        p.vertices[i] +
        '" y="' +
        p.vertices[i + 1] +
        '" z="' +
        p.vertices[i + 2] +
        '"/>'
    );
  segments.push('</vertices><triangles>');
  const cursor = { cell: 0, node: 0 };
  for (let i = 0; i < p.depth.length; i++) {
    const code = encodePaintTree(p.paint, cursor, p.depth[i], slots, p.splits);
    segments.push(
      '<triangle v1="' +
        p.faces[i * 3] +
        '" v2="' +
        p.faces[i * 3 + 1] +
        '" v3="' +
        p.faces[i * 3 + 2] +
        '" paint_color="' +
        code +
        '"/>'
    );
  }
  segments.push(
    '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
  );
  const settings = {
    version: '2.3.2.0',
    filament_colour: colors,
    filament_settings_id: colors.map(() => 'Generic PLA'),
    filament_type: colors.map(() => 'PLA'),
    filament_diameter: colors.map(() => '1.75'),
  };
  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        header +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/octet-stream"/></Types>'
      ),
      '_rels/.rels': strToU8(
        header +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
      ),
      '3D/3dmodel.model': strToU8(segments.join('')),
      'Metadata/project_settings.config': json(settings),
      'Metadata/model_settings.config': strToU8(
        header +
          '<config><object id="1"><metadata key="name" value="' +
          xml(p.name) +
          '"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="' +
          xml(p.name) +
          '"/><metadata key="extruder" value="1"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance></plate></config>'
      ),
    },
    { level: 4 }
  );
}
