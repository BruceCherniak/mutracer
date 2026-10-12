import type Geometry from '../scene/Geometry.js';
import type { FlattendBVH } from './bvhAccel.js';

const geometryBvhs = new WeakMap<Geometry, FlattendBVH>();

export function getGeometryBvh(geometry: Geometry) {
  return geometryBvhs.get(geometry);
}

export function setGeometryBvh(geometry: Geometry, bvh: FlattendBVH | undefined) {
  if (bvh) geometryBvhs.set(geometry, bvh);
  else geometryBvhs.delete(geometry);
}
