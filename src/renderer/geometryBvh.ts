import type { TinyBvhLayout } from '../tinybvh/TinyBvhBuilder.js';
import type Geometry from '../scene/Geometry.js';
import type { FlattendBVH } from './bvhAccel.js';

export interface BvhBuildConfig { builder: 'builtin' | 'tinybvh'; layout: TinyBvhLayout; spatialSplits: boolean }
const configurations = new WeakMap<Geometry, BvhBuildConfig>();
export function geometryBvhConfigMatches(geometry: Geometry, config: BvhBuildConfig) {
  const bvh = getGeometryBvh(geometry);
  const previous = configurations.get(geometry) ?? (bvh ? { builder: bvh.builder ?? 'builtin', layout: bvh.layout ?? 'bvh2', spatialSplits: false } : undefined);
  return !!previous && previous.builder === config.builder && previous.layout === config.layout && previous.spatialSplits === config.spatialSplits;
}

const geometryBvhs = new WeakMap<Geometry, FlattendBVH>();

export function getGeometryBvh(geometry: Geometry) {
  return geometryBvhs.get(geometry);
}

export function setGeometryBvh(geometry: Geometry, bvh: FlattendBVH | undefined, config?: BvhBuildConfig) {
  if (bvh) {
    geometryBvhs.set(geometry, bvh);
    if (config) configurations.set(geometry, { ...config });
    else configurations.delete(geometry);
  } else { geometryBvhs.delete(geometry); configurations.delete(geometry); }
}
