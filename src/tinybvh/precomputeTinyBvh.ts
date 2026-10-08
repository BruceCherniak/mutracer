import type Mesh from '../scene/Mesh';
import {
  getCachedPreparedMeshGeometry
} from '../renderer/prepareMeshBVH';
import {
  meshNeedsPrecompute,
  prepareForPrecompute,
  precompute,
  resolveFromPrecompute,
  type PrecomputeProgress
} from '../util/workerHelper';
import {
  buildTinyBvh,
  initializeTinyBvh,
  type TinyBvhLayout
} from './TinyBvhBuilder';

export interface TinyBvhPrecomputeStats {
  builder: 'tinybvh';
  requestedLayout: TinyBvhLayout;
  layout: TinyBvhLayout | 'mixed';
  geometryCount: number;
  bvhTimeMs: number;
  bvhBuildTimeMs: number;
  bvhRefitTimeMs: number;
  bvhRefitCount: number;
}

/**
 * Builds mesh BLAS data with TinyBVH.
 *
 * By default every geometry is rebuilt. Pass `onlyMissing: true` to build only
 * meshes that do not have a BVH yet, which is what the renderer does
 * automatically before the first frame.
 */
export async function precomputeTinyBvh(
  meshes: Mesh[],
  requestedLayout: TinyBvhLayout = 'bvh2',
  onProgress?: (progress: PrecomputeProgress) => void,
  { onlyMissing = false }: { onlyMissing?: boolean } = {}
): Promise<TinyBvhPrecomputeStats> {
  meshes = meshes.filter((mesh) =>
    onlyMissing ? meshNeedsPrecompute(mesh) : mesh.geometry.position.array.length > 0
  );
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
    await initializeTinyBvh();
    const prepared = prepareForPrecompute(meshes);
    const result = await precompute(
      prepared.geometries,
      prepared.displacementScales,
      prepared.trianglesDisplacements,
      (geometry, displacementScale, trianglesDisplacement, refitKey) =>
        buildTinyBvh(
          geometry,
          displacementScale,
          trianglesDisplacement,
          requestedLayout,
          refitKey
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

    const layouts = new Set(bvhs.map((bvh) => bvh!.layout ?? 'bvh2'));
    return {
      builder: 'tinybvh',
      requestedLayout,
      layout:
        layouts.size > 1
          ? 'mixed'
          : (layouts.values().next().value ?? requestedLayout),
      geometryCount: bvhs.length,
      ...result.timings
    };
  } catch (error) {
    geometries.forEach((geometry) => {
      geometry.bvh = previousBvhs.get(geometry);
    });
    throw error;
  }
}
