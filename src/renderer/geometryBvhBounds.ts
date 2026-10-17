import type Geometry from '../scene/Geometry.js';
import { vec3 } from '../math.js';
import { getGeometryBvh } from './geometryBvh.js';

export function computeGeometryBounds(geometry: Geometry) {
  const min = vec3.fromValues(Infinity, Infinity, Infinity);
  const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
  const positions = geometry.position.array;
  const stride = geometry.position.itemSize;
  for (let offset = 0; offset + 2 < positions.length; offset += stride) {
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }
  return [min, max] as [vec3.Vec3Array, vec3.Vec3Array];
}

export function getBvhBounds(geometry: Geometry) {
  const bvh = getGeometryBvh(geometry)!;
  const floats = new Float32Array(bvh.buffer);
  if (bvh.layout === 'bvh4') {
    return [
      [floats[0], floats[1], floats[2]],
      [
        floats[0] + floats[3],
        floats[1] + floats[4],
        floats[2] + floats[5]
      ]
    ] as [vec3.Vec3Array, vec3.Vec3Array];
  }
  if (bvh.layout === 'bvh-gpu') {
    const words = new Uint32Array(bvh.buffer);
    if (words[11] === 0) {
      return [
        [
          Math.min(floats[0], floats[8]),
          Math.min(floats[1], floats[9]),
          Math.min(floats[2], floats[10])
        ],
        [
          Math.max(floats[4], floats[12]),
          Math.max(floats[5], floats[13]),
          Math.max(floats[6], floats[14])
        ]
      ] as [vec3.Vec3Array, vec3.Vec3Array];
    }
    // A single-leaf BVH_GPU node does not store its own bounds.
    return computeGeometryBounds(geometry);
  }
  if (bvh.layout === 'cwbvh') {
    const words = new Uint32Array(bvh.buffer);
    const header = words[3];
    const signedByte = (value: number) => (value << 24) >> 24;
    const scale = [
      2 ** signedByte(header),
      2 ** signedByte(header >> 8),
      2 ** signedByte(header >> 16)
    ];
    const min: vec3.Vec3Array = [floats[0], floats[1], floats[2]];
    const max: vec3.Vec3Array = [...min];
    for (let slot = 0; slot < 8; slot++) {
      const meta = (words[6 + (slot >> 2)] >> ((slot & 3) * 8)) & 0xff;
      if (!meta) continue;
      const shift = (slot & 3) * 8;
      const half = slot >> 2;
      max[0] = Math.max(max[0], min[0] + ((words[14 + half] >> shift) & 0xff) * scale[0]);
      max[1] = Math.max(max[1], min[1] + ((words[16 + half] >> shift) & 0xff) * scale[1]);
      max[2] = Math.max(max[2], min[2] + ((words[18 + half] >> shift) & 0xff) * scale[2]);
    }
    return [min, max] as [vec3.Vec3Array, vec3.Vec3Array];
  }
  return [
    [floats[0], floats[1], floats[2]],
    [floats[4], floats[5], floats[6]]
  ] as [vec3.Vec3Array, vec3.Vec3Array];
}
