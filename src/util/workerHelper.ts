import { buildBLAS, flattenBvh, FlattendBVH } from '../renderer/bvhAccel';
import {
  cachePreparedMeshGeometry,
  getCachedPreparedMeshGeometry,
  getMeshDisplacementMap,
  getMeshDisplacementTessellationOptions,
  getMeshGeometrySimplificationRatio,
  getTrianglesDisplacementRange,
  getMeshDisplacementMaterial,
  getMeshDisplacementScale,
  getPreparedMeshGeometryCacheKey,
  getDisplacementTextureDataCacheKey
} from '../renderer/prepareMeshBVH';
import Texture from '../scene/Texture';
import {
  copyDisplacementTextureData,
  getDisplacementTessellationStats,
  setDisplacementTessellationStats,
  tessellateDisplacementGeometry,
  type DisplacementTessellationMode,
  type DisplacementTessellationOptions,
  type DisplacementTessellationStats
} from './tessellateDisplacement';
import { generateVertexNormals } from './geometry';
import Geometry, {
  AttributeName,
  Attribute as GeometryAttribute,
  AVAILABLE_ATTRIBUTES,
  GeometryData
} from '../scene/Geometry';
import Mesh from '../scene/Mesh';
import OpenPBRMaterial from '../scene/OpenPBRMaterial';

export type GeometryForTransfer = Record<
  AttributeName | 'materialIndex' | 'indices',
  | {
      buffer: ArrayBuffer;
      itemSize: number;
    }
  | undefined
> & {
  dynamic?: boolean;
  bvh?: BVHForTransfer;
  tessellationStats?: DisplacementTessellationStats;
};

export interface DisplacementTextureForTransfer {
  buffer: ArrayBuffer;
  arrayType: 'float32' | 'int32' | 'uint8';
  width: number;
  height: number;
  flipY: boolean;
  uvScale: [number, number];
  uvOffset: [number, number];
  cacheKey: string;
}

export interface DisplacementTessellationForTransfer {
  texture: DisplacementTextureForTransfer;
  options: DisplacementTessellationOptions;
}

export interface ProjectiveDisplacementForTransfer {
  texture: DisplacementTextureForTransfer;
  uvProjection: OpenPBRMaterial['displacementUvProjection'];
  uvScale: number;
}

export interface PrecomputeProgress {
  stage: 'tessellation' | 'simplification' | 'bvh';
  progress: number;
  mode: DisplacementTessellationMode | 'projective';
}

export interface RefinedDisplacementTopology {
  geometry: Geometry;
  postTessellationOptions: DisplacementTessellationOptions;
  triangleBudgetReached: boolean;
  adaptiveFaceLevelCounts?: number[];
  recoveredQuadCount?: number;
  remainingControlTriangleCount?: number;
}

/** Viewer or application hook for an optional asynchronous topology backend. */
export type DisplacementTopologyRefiner = (
  geometry: Geometry,
  texture: Texture,
  options: DisplacementTessellationOptions
) => Promise<RefinedDisplacementTopology>;

/** Application hook that runs after optional displacement and before BVH construction. */
export type DisplacementGeometryPostprocessor = (
  geometry: Geometry,
  options: DisplacementTessellationOptions
) => Geometry | Promise<Geometry>;

interface BVHForTransfer {
  builder?: 'builtin' | 'tinybvh';
  maxDepth: number;
  buffer: ArrayBuffer;
  layout?: 'bvh2' | 'bvh4' | 'bvh-gpu' | 'cwbvh';
}

export interface PrecomputePreparedData {
  geometries: GeometryForTransfer[];
  displacementScales: number[];
  trianglesDisplacements: (ArrayBuffer | undefined)[];
  rawGeometries: Geometry[];
  rawMeshes: Mesh[];
  tessellations: (DisplacementTessellationForTransfer | undefined)[];
  geometryPostprocessOptions: (
    | DisplacementTessellationOptions
    | undefined
  )[];
  projectiveDisplacements: (ProjectiveDisplacementForTransfer | undefined)[];
  buffers: ArrayBuffer[];
}

export interface PrecomputeResult {
  geometries: GeometryForTransfer[];
  buffers: ArrayBuffer[];
  timings: PrecomputeTimings;
}

export interface PrecomputeTimings {
  bvhTimeMs: number;
  bvhBuildTimeMs: number;
  bvhRefitTimeMs: number;
  bvhRefitCount: number;
}

export function convertGeometryToTransfer(
  geometry: Geometry,
  outputBuffers: ArrayBuffer[]
): GeometryForTransfer {
  const transferGeometry = (
    [...AVAILABLE_ATTRIBUTES, 'indices', 'materialIndex'] as const
  ).reduce((obj, attrName) => {
    const attr = geometry[attrName];
    const buffer =
      attr &&
      ((attrName === 'indices' ? new Uint32Array(attr.array) : attr.array)
        .buffer as ArrayBuffer);
    obj[attrName] = attr && {
      // Always use Uint32Array to simplify
      buffer: buffer!,
      itemSize: attr.itemSize
    };
    if (buffer) {
      outputBuffers.push(buffer);
    }
    return obj;
  }, {} as GeometryForTransfer);

  if (geometry.bvh) {
    outputBuffers.push(geometry.bvh.buffer);
    transferGeometry.bvh = geometry.bvh;
  }
  transferGeometry.dynamic = geometry.dynamic;
  transferGeometry.tessellationStats =
    getDisplacementTessellationStats(geometry);
  return transferGeometry;
}

export function convertGeometryFromTransfer(geometry: GeometryForTransfer) {
  const ret = new Geometry({
    ...AVAILABLE_ATTRIBUTES.reduce((obj, attrName) => {
      obj[attrName] =
        geometry[attrName] &&
        new GeometryAttribute(
          new Float32Array(geometry[attrName]!.buffer),
          geometry[attrName]!.itemSize
        );
      return obj;
    }, {} as Partial<GeometryData>),
    indices:
      geometry.indices &&
      new GeometryAttribute(
        new Uint32Array(geometry.indices.buffer),
        geometry.indices.itemSize
      )
  });
  ret.dynamic = geometry.dynamic ?? false;
  ret.bvh = geometry.bvh;
  if (geometry.tessellationStats) {
    setDisplacementTessellationStats(ret, geometry.tessellationStats);
  }
  if (geometry.materialIndex) {
    ret.materialIndex = new GeometryAttribute(
      new Int32Array(geometry.materialIndex.buffer),
      geometry.materialIndex.itemSize
    );
  }
  return ret;
}

function textureForTransfer(texture: Texture): DisplacementTextureForTransfer {
  const textureData = copyDisplacementTextureData(texture);
  if (!textureData) {
    throw new Error('The displacement texture is not CPU-readable.');
  }
  return {
    buffer: textureData.data.buffer as ArrayBuffer,
    arrayType: textureData.data instanceof Float32Array
      ? 'float32'
      : textureData.data instanceof Int32Array
        ? 'int32'
        : 'uint8',
    width: textureData.width,
    height: textureData.height,
    flipY: texture.flipY,
    uvScale: [...texture.uvScale],
    uvOffset: [...texture.uvOffset],
    cacheKey: getDisplacementTextureDataCacheKey(texture)
  };
}

function textureFromTransfer(transferred: DisplacementTextureForTransfer) {
  const data = transferred.arrayType === 'float32'
    ? new Float32Array(transferred.buffer)
    : transferred.arrayType === 'int32'
      ? new Int32Array(transferred.buffer)
      : new Uint8Array(transferred.buffer);
  const texture = new Texture({
    data,
    width: transferred.width,
    height: transferred.height
  });
  texture.flipY = transferred.flipY;
  texture.uvScale = transferred.uvScale;
  texture.uvOffset = transferred.uvOffset;
  texture.tessellationCacheKey = transferred.cacheKey;
  return texture;
}

/**
 * Whether the mesh still needs a BLAS build (or displacement tessellation)
 * before it can be rendered.
 */
export function meshNeedsPrecompute(mesh: Mesh) {
  if (!mesh.geometry.position.array.length) return false;
  const cacheKey = getPreparedMeshGeometryCacheKey(mesh);
  const cached = getCachedPreparedMeshGeometry(mesh);
  const geometry = cached ?? mesh.geometry;
  return !geometry.bvh || (cacheKey != null && !cached);
}

export function prepareForPrecompute(meshes: Mesh[]): PrecomputePreparedData {
  const buffers: ArrayBuffer[] = [];
  const geometries: Geometry[] = [];
  const displacementScales: number[] = [];
  const trianglesDisplacements: (ArrayBuffer | undefined)[] = [];
  const rawMeshes: Mesh[] = [];
  const tessellations: (DisplacementTessellationForTransfer | undefined)[] = [];
  const geometryPostprocessOptions: (
    | DisplacementTessellationOptions
    | undefined
  )[] = [];
  const projectiveDisplacements: (
    | ProjectiveDisplacementForTransfer
    | undefined
  )[] = [];
  const geometryKeys = new Map<Geometry, Set<string>>();
  meshes.forEach((mesh) => {
    const cacheKey = getPreparedMeshGeometryCacheKey(mesh);
    const cached = getCachedPreparedMeshGeometry(mesh);
    const geometry = cached ?? mesh.geometry;
    const identityKey = cacheKey ?? 'source';
    let accessed = geometryKeys.get(mesh.geometry);
    if (!accessed) {
      accessed = new Set();
      geometryKeys.set(mesh.geometry, accessed);
    }
    if (!accessed.has(identityKey)) {
      // Filter geometries don't needs to update bvh.
      if (!geometry.bvh || (cacheKey != null && !cached)) {
        accessed.add(identityKey);
        if (!geometry.normal) generateVertexNormals(geometry);
        geometries.push(geometry);
        rawMeshes.push(mesh);
        const material = getMeshDisplacementMaterial(mesh);
        const explicitTexture =
          cacheKey != null &&
          !cached &&
          material.displacementMode === 'tessellated' &&
          (Math.abs(material.displacementScale) > 1e-6 ||
            Math.abs(material.displacementBias) > 1e-6)
            ? material.displacementMap
            : undefined;
        if (explicitTexture) {
          tessellations.push({
            texture: textureForTransfer(explicitTexture),
            options: getMeshDisplacementTessellationOptions(mesh)
          });
        } else {
          tessellations.push(undefined);
        }
        const simplificationRatio = getMeshGeometrySimplificationRatio(mesh);
        geometryPostprocessOptions.push(
          simplificationRatio < 1 ? { simplificationRatio } : undefined
        );
        const displacementMap = explicitTexture
          ? undefined
          : getMeshDisplacementMap(mesh);
        const displacementScale = displacementMap
          ? getMeshDisplacementScale(mesh)
          : 0;
        displacementScales.push(displacementScale);
        trianglesDisplacements.push(undefined);
        projectiveDisplacements.push(
          displacementMap
            ? {
                texture: textureForTransfer(displacementMap),
                uvProjection: material.displacementUvProjection,
                uvScale: material.displacementUvScale
              }
            : undefined
        );
      }
    }
  });

  return {
    geometries: geometries.map((geometry) =>
      convertGeometryToTransfer(geometry, buffers)
    ),
    displacementScales,
    trianglesDisplacements,
    rawGeometries: geometries,
    rawMeshes,
    tessellations,
    geometryPostprocessOptions,
    projectiveDisplacements,
    buffers
  };
}
export async function precompute(
  inGeometries: GeometryForTransfer[],
  displacementScales: number[],
  trianglesDisplacements: (ArrayBuffer | undefined)[],
  /**
   * Users can provide a faster bvh builder, like wasm version.
   */
  buildBVH?: (
    geometry: Geometry,
    displacementScale: number,
    trianglesDisplacement?: Float32Array,
    refitKey?: string
  ) => Promise<FlattendBVH>,
  tessellations: (DisplacementTessellationForTransfer | undefined)[] = [],
  onProgress?: (progress: PrecomputeProgress) => void,
  projectiveDisplacements: (
    | ProjectiveDisplacementForTransfer
    | undefined
  )[] = [],
  refineDisplacementTopology?: DisplacementTopologyRefiner,
  postprocessDisplacementGeometry?: DisplacementGeometryPostprocessor,
  geometryPostprocessOptions: (
    | DisplacementTessellationOptions
    | undefined
  )[] = []
): Promise<PrecomputeResult> {
  const buffers: ArrayBuffer[] = [];
  const bvhBuildPromiseMap = new WeakMap<
    GeometryForTransfer,
    Promise<FlattendBVH>
  >();
  const tessellationIndices = tessellations.flatMap((entry, index) =>
    entry ? [index] : []
  );
  const tessellationOrdinal = new Map(
    tessellationIndices.map((index, ordinal) => [index, ordinal])
  );
  const simplificationIndices = inGeometries.flatMap((_, index) => {
    const options =
      tessellations[index]?.options ?? geometryPostprocessOptions[index];
    return (options?.simplificationRatio ?? 1) < 1 ? [index] : [];
  });
  const simplificationOrdinal = new Map(
    simplificationIndices.map((index, ordinal) => [index, ordinal])
  );
  const progressMode =
    tessellations[tessellationIndices[0]]?.options.mode ?? 'projective';
  let completedBvhs = 0;
  const timings: PrecomputeTimings = {
    bvhTimeMs: 0,
    bvhBuildTimeMs: 0,
    bvhRefitTimeMs: 0,
    bvhRefitCount: 0
  };

  async function createBVH(
    geo: Geometry,
    displacementScale: number,
    trianglesDisplacementBuffer?: ArrayBuffer,
    refitKey?: string
  ) {
    const trianglesDisplacement = trianglesDisplacementBuffer
      ? new Float32Array(trianglesDisplacementBuffer)
      : undefined;
    try {
      const start = typeof performance === 'undefined' ? Date.now() : performance.now();
      const built = await (buildBVH && !geo.dynamic
        ? buildBVH(geo, displacementScale, trianglesDisplacement, refitKey)
        : flattenBvh(
            buildBLAS(geo, displacementScale, trianglesDisplacement),
            false
          ));
      const measured = (built as FlattendBVH & { bvhTimeMs?: number }).bvhTimeMs ??
        (typeof performance === 'undefined' ? Date.now() : performance.now()) - start;
      const operation = (built as FlattendBVH & {
        bvhOperation?: 'build' | 'refit';
      }).bvhOperation ?? 'build';
      timings.bvhTimeMs += measured;
      if (operation === 'refit') {
        timings.bvhRefitTimeMs += measured;
        timings.bvhRefitCount++;
      } else {
        timings.bvhBuildTimeMs += measured;
      }
      return built;
    } catch (e) {
      // An application-supplied builder is an explicit acceleration-structure
      // choice. Propagate its failure instead of silently substituting the
      // built-in builder or an empty BVH.
      if (buildBVH) throw e;
      console.error(e);
      // In case there are bad data.
      return flattenBvh(undefined, false);
    }
  }
  const res = {
    geometries: await Promise.all(
      inGeometries.map(async (geometry, idx) => {
        let newGeo = convertGeometryFromTransfer(geometry);
        const tessellation = tessellations[idx];
        if (tessellation) {
          const texture = textureFromTransfer(tessellation.texture);
          const ordinal = tessellationOrdinal.get(idx) ?? 0;
          const reportTessellationProgress = (progress: number) => {
            onProgress?.({
              stage: 'tessellation',
              progress:
                (ordinal + Math.min(Math.max(progress, 0), 1)) /
                Math.max(tessellationIndices.length, 1),
              mode: tessellation.options.mode ?? 'adaptive'
            });
          };
          if (tessellation.options.mode === 'opensubdiv') {
            if (!refineDisplacementTopology) {
              throw new Error(
                'OpenSubdiv displacement requires an asynchronous topology refiner.'
              );
            }
            const sourceGeometry = newGeo;
            const sourceStats = {
              triangles: sourceGeometry.indices.array.length / 3,
              vertices: Geometry.getVertexCount(sourceGeometry)
            };
            const topologyStart = typeof performance === 'undefined'
              ? Date.now()
              : performance.now();
            reportTessellationProgress(0.02);
            const refined = await refineDisplacementTopology(
              sourceGeometry,
              texture,
              tessellation.options
            );
            const topologyTimeMs = (typeof performance === 'undefined'
              ? Date.now()
              : performance.now()) - topologyStart;
            reportTessellationProgress(0.52);
            newGeo = tessellateDisplacementGeometry(
              refined.geometry,
              texture,
              refined.postTessellationOptions,
              ({ progress }) => reportTessellationProgress(0.52 + progress * 0.4)
            );
            const stats = getDisplacementTessellationStats(newGeo);
            if (stats) {
              setDisplacementTessellationStats(newGeo, {
                ...stats,
                sourceTriangles: sourceStats.triangles,
                sourceVertices: sourceStats.vertices,
                topologyTimeMs: stats.topologyTimeMs + topologyTimeMs,
                buildTimeMs: stats.buildTimeMs + topologyTimeMs,
                triangleBudgetReached:
                  stats.triangleBudgetReached || refined.triangleBudgetReached,
                adaptiveFaceLevelCounts: refined.adaptiveFaceLevelCounts,
                recoveredQuadCount: refined.recoveredQuadCount,
                remainingControlTriangleCount:
                  refined.remainingControlTriangleCount
              });
            }
          } else {
            newGeo = tessellateDisplacementGeometry(
              newGeo,
              texture,
              tessellation.options,
              ({ progress }) => reportTessellationProgress(progress)
            );
          }
          reportTessellationProgress(1);
        }
        const postprocessOptions =
          tessellation?.options ?? geometryPostprocessOptions[idx];
        if (
          postprocessDisplacementGeometry &&
          postprocessOptions &&
          (postprocessOptions.simplificationRatio ?? 1) < 1
        ) {
          const ordinal = simplificationOrdinal.get(idx) ?? 0;
          onProgress?.({
            stage: 'simplification',
            progress: ordinal / Math.max(simplificationIndices.length, 1),
            mode: progressMode
          });
          newGeo = await postprocessDisplacementGeometry(
            newGeo,
            postprocessOptions
          );
          onProgress?.({
            stage: 'simplification',
            progress:
              (ordinal + 1) / Math.max(simplificationIndices.length, 1),
            mode: progressMode
          });
        }
        const projective = projectiveDisplacements[idx];
        if (projective) {
          const material = new OpenPBRMaterial();
          material.displacementUvProjection = projective.uvProjection;
          material.displacementUvScale = projective.uvScale;
          trianglesDisplacements[idx] = getTrianglesDisplacementRange(
            newGeo,
            textureFromTransfer(projective.texture),
            material
          )?.buffer;
        }
        let bvh = tessellation ? undefined : geometry.bvh;
        const displacementScale = displacementScales[idx];
        if (!bvh) {
          const bvhPromise = bvhBuildPromiseMap.get(geometry);
          if (bvhPromise) {
            bvh = await bvhPromise;
          } else {
            const promise = createBVH(
              newGeo,
              displacementScale,
              trianglesDisplacements[idx],
              tessellation?.options.mode === 'uniform'
                ? tessellation.options.topologyCacheKey
                : undefined
            );
            bvhBuildPromiseMap.set(geometry, promise);
            bvh = await promise;
          }
        }
        if (onProgress) {
          completedBvhs++;
          onProgress({
            stage: 'bvh',
            progress: completedBvhs / Math.max(inGeometries.length, 1),
            mode: progressMode
          });
        }
        const ret = convertGeometryToTransfer(newGeo, buffers);
        ret.bvh = bvh;
        if (bvh && !buffers.includes(bvh.buffer)) buffers.push(bvh.buffer);
        return ret;
      })
    ),
    buffers,
    timings
  };
  return res;
}

export function resolveFromPrecompute(
  precomputeData: Omit<PrecomputeResult, 'buffers'>,
  preparedData: PrecomputePreparedData
) {
  precomputeData.geometries.forEach((geo, idx) => {
    const resolved = convertGeometryFromTransfer(geo);
    if (
      preparedData.tessellations[idx] ||
      preparedData.geometryPostprocessOptions[idx]
    ) {
      cachePreparedMeshGeometry(preparedData.rawMeshes[idx], resolved);
    } else {
      preparedData.rawGeometries[idx].bvh = geo.bvh;
    }
  });
}
