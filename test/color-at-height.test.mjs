import test from 'node:test';
import assert from 'node:assert/strict';
import { cellHeights, findColorConflict } from '../src/color-at-height.js';

function check(cells, limit = 4) {
  const heights = Float32Array.from(cells.flatMap(([lo, hi]) => [lo, hi]));
  return findColorConflict(
    heights,
    Uint8Array.from(cells, (c) => c[2]),
    limit
  );
}

test('five simultaneous slots exceed four, including base and the sixteenth slot', () => {
  const cells = [
    [1, 8, 0],
    [2, 7, 2],
    [3, 6, 7],
    [4, 6, 11],
    [4, 6, 15],
    [4, 5, 2],
  ];
  assert.deepEqual(check(cells), { count: 5, mask: 1 | 4 | 128 | 2048 | 32768, z: 5 });
  assert.equal(check(cells, 5), null);
});

test('separate bands, gaps and repeated cells do not use extra slots', () => {
  const four = [0, 1, 2, 3].map((c) => [0, 5, c]);
  const swap = [4, 5, 6, 7].map((c) => [5, 10, c]);
  assert.equal(check([...four, ...four, ...swap]), null);
  assert.equal(
    check(
      [
        [0, 1, 0],
        [2, 3, 0],
        [1, 2, 1],
      ],
      1
    ),
    null
  );
});

test('coplanar artwork, caps and narrow bands are checked without height sampling', () => {
  const cap = [0, 1, 2, 3, 4].map((c) => [-2, -2, c]);
  assert.deepEqual(check(cap), { count: 5, mask: 31, z: -2 });
  assert.deepEqual(
    check(
      [
        [0, 3, 0],
        [3, 3, 1],
      ],
      1
    ),
    { count: 2, mask: 3, z: 3 }
  );
  const sliver = check(
    [
      [1, 4, 0],
      [1.0001, 1.0002, 1],
    ],
    1
  );
  assert.ok(sliver.z > 1.0001 && sliver.z < 1.0002);
  assert.deepEqual([...cellHeights([5, 6, -1, 4, 5, 7, 3, 4, 2])], [-1, 7]);
});
