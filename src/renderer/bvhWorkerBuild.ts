import { buildTinyBvh } from '../tinybvh/TinyBvhBuilder.js';
import Geometry from '../scene/Geometry.js';
import { buildBLAS } from './bvhAccel.js';
import type { BvhBuildRequest } from './bvhWorkerClient.js';

/** Shared worker operation, also executable without browser globals in tests. */
export async function executeBvhBuild(request: BvhBuildRequest) {
  const geometry = new Geometry({
    position: request.position, normal: request.normal, indices: request.indices
  });
  geometry.dynamic = request.dynamic;
  if (request.builder === 'tinybvh' && !geometry.dynamic) {
    return buildTinyBvh(geometry, request.displacementScale, request.trianglesDisplacement,
      request.layout, request.refitKey, request.spatialSplits);
  }
  const start = performance.now();
  return { ...buildBLAS(geometry, request.displacementScale, request.trianglesDisplacement),
    bvhTimeMs: performance.now() - start, bvhOperation: 'build' as const };
}
