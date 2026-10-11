import type Mesh from '../scene/Mesh.js';
import { buildBvhInWorker, canUseBvhWorker } from '../renderer/bvhWorkerClient.js';
import {
  getCachedPreparedMeshGeometry
} from '../renderer/prepareMeshBVH.js';
import {
  meshNeedsPrecompute,
  prepareForPrecompute,
  precompute,
  resolveFromPrecompute,
  type PrecomputeTimings,
  type PrecomputeProgress
} from '../util/workerHelper.js';
import {
  buildTinyBvh,
  initializeTinyBvh,
  type TinyBvhLayout
} from './TinyBvhBuilder.js';

export interface TinyBvhPrecomputeStats {
  /** Precomputation entry point; dynamic geometries use the built-in builder. */
  builder: 'tinybvh';
  requestedLayout: TinyBvhLayout;
  layout: TinyBvhLayout | 'mixed';
  geometryCount: number;
  bvhTimeMs: number;
  bvhBuildTimeMs: number;
  bvhRefitTimeMs: number;
  bvhRefitCount: number;
}

export interface TinyBvhPrecomputeOptions {
  /** Build only meshes without a BVH. Default `false`: rebuild every static geometry. */
  onlyMissing?: boolean;
  /**
   * Use spatial splits (SBVH) for static triangle BLASes. Lower traversal
   * cost on some scenes, several times slower to build. Default `false`
   * (binned SAH).
   */
  spatialSplits?: boolean;
}

/**
 * Builds static mesh BLAS data with TinyBVH and dynamic geometry with the built-in builder.
 * Static BLAS construction uses a reusable Worker when available; input arrays
 * remain attached. Without Worker support, construction runs on the calling thread.
 *
 * By default every static geometry is rebuilt; already prepared dynamic BVHs
 * are retained. Pass `onlyMissing: true` to build only
 * meshes that do not have a BVH yet, which is what the renderer does
 * automatically before the first frame.
 */
export async function precomputeTinyBvh(
  meshes: Mesh[],
  requestedLayout: TinyBvhLayout = 'bvh2',
  onProgress?: (progress: PrecomputeProgress) => void,
  { onlyMissing = false, spatialSplits = false }: TinyBvhPrecomputeOptions = {}
): Promise<TinyBvhPrecomputeStats> {
  let dynamicResult: Awaited<ReturnType<typeof precompute>> | undefined;
  const dynamicMeshes = meshes.filter(mesh => mesh.geometry.dynamic);
  if (dynamicMeshes.length) {
    const prepared = prepareForPrecompute(dynamicMeshes);
    const result = await precompute(prepared.geometries, prepared.displacementScales,
      prepared.trianglesDisplacements, undefined, prepared.tessellations, onProgress, prepared.projectiveDisplacements);
    resolveFromPrecompute(result, prepared);
    dynamicResult = result;
  }
  meshes = meshes.filter(mesh => !mesh.geometry.dynamic).filter(mesh =>
    onlyMissing ? meshNeedsPrecompute(mesh) : mesh.geometry.position.array.length > 0);
  if (!meshes.length) return { builder: 'tinybvh', requestedLayout, layout: 'bvh2',
    geometryCount: dynamicResult?.geometries.length ?? 0,
    ...mergeTimings(undefined, dynamicResult?.timings) };
  const geometries = new Set(
    meshes.flatMap((mesh) => {
      const prepared = getCachedPreparedMeshGeometry(mesh);
      return prepared ? [mesh.geometry, prepared] : [mesh.geometry];
    })
  );
  const previousBvhs = new Map(
    [...geometries]
      .filter((geometry) => geometry.bvh)
      .map((geometry) => [geometry, geometry.bvh!] as const)
  );
  if (!onlyMissing) {
    geometries.forEach((geometry) => {
      geometry.bvh = undefined;
    });
  }

  try {
    // WASM loading and compilation are intentionally outside the measured
    // TinyBVH build timings returned by precompute().
    if (!canUseBvhWorker()) await initializeTinyBvh();
    const prepared = prepareForPrecompute(meshes);
    const result = await precompute(
      prepared.geometries,
      prepared.displacementScales,
      prepared.trianglesDisplacements,
      (geometry, displacementScale, trianglesDisplacement, refitKey) =>
        canUseBvhWorker()
          ? buildBvhInWorker(geometry, displacementScale, trianglesDisplacement, 'tinybvh',
              requestedLayout, refitKey, spatialSplits)
          : buildTinyBvh(
              geometry, displacementScale, trianglesDisplacement,
              requestedLayout, refitKey, spatialSplits
            ),
      prepared.tessellations,
      onProgress,
      prepared.projectiveDisplacements
    );

    const bvhs = result.geometries.map((geometry) => geometry.bvh);
    const invalid = bvhs.find(
      (bvh) => !bvh || bvh.builder !== 'tinybvh' || !bvh.buffer.byteLength
    );
    if (invalid !== undefined || bvhs.some((bvh) => !bvh)) {
      throw new Error('TinyBVH did not build every scene geometry.');
    }
    resolveFromPrecompute(result, prepared);

    const layouts = new Set([...bvhs, ...(dynamicResult?.geometries.map(g => g.bvh) ?? [])]
      .map((bvh) => bvh!.layout ?? 'bvh2'));
    return {
      builder: 'tinybvh',
      requestedLayout,
      layout:
        layouts.size > 1
          ? 'mixed'
          : (layouts.values().next().value ?? requestedLayout),
      geometryCount: bvhs.length + (dynamicResult?.geometries.length ?? 0),
      ...mergeTimings(result.timings, dynamicResult?.timings)
    };
  } catch (error) {
    geometries.forEach((geometry) => {
      geometry.bvh = previousBvhs.get(geometry);
    });
    throw error;
  }
}

function mergeTimings(a?: PrecomputeTimings, b?: PrecomputeTimings): PrecomputeTimings {
  return {
    bvhTimeMs: (a?.bvhTimeMs ?? 0) + (b?.bvhTimeMs ?? 0),
    bvhBuildTimeMs: (a?.bvhBuildTimeMs ?? 0) + (b?.bvhBuildTimeMs ?? 0),
    bvhRefitTimeMs: (a?.bvhRefitTimeMs ?? 0) + (b?.bvhRefitTimeMs ?? 0),
    bvhRefitCount: (a?.bvhRefitCount ?? 0) + (b?.bvhRefitCount ?? 0)
  };
}
