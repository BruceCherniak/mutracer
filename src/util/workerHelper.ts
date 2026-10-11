import { buildBLAS, emptyBLAS, FlattendBVH } from '../renderer/bvhAccel.js';
import {
  getCachedPreparedMeshGeometry,
  getMeshDisplacementMap,
  getTrianglesDisplacementRange,
  getMeshDisplacementMaterial,
  getMeshDisplacementScale,
  getPreparedMeshGeometryCacheKey,
  getDisplacementTextureDataCacheKey
} from '../renderer/prepareMeshBVH.js';
import Texture from '../scene/Texture.js';
import { copyDisplacementTextureData } from './displacementData.js';
import { generateVertexNormals } from './geometry.js';
import Geometry, {
  AttributeName,
  Attribute as GeometryAttribute,
  AVAILABLE_ATTRIBUTES,
  GeometryData
} from '../scene/Geometry.js';
import Mesh from '../scene/Mesh.js';
import OpenPBRMaterial from '../scene/OpenPBRMaterial.js';

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

export interface ProjectiveDisplacementForTransfer {
  texture: DisplacementTextureForTransfer;
  uvProjection: OpenPBRMaterial['displacementUvProjection'];
  uvScale: number;
}

export interface PrecomputeProgress {
  stage: 'bvh';
  progress: number;
}

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
  projectiveDisplacements: (ProjectiveDisplacementForTransfer | undefined)[];
  buffers: ArrayBuffer[];
  /** Internal input revisions used to discard results superseded during async work. */
  snapshots?: {
    geometry: Geometry;
    version: number;
    cacheKey?: string;
    bvh?: FlattendBVH;
    displacementMap?: Texture;
    displacementScale: number;
    displacementTextureKey?: string;
  }[];
}

export interface PrecomputeResult {
  geometries: GeometryForTransfer[];
  buffers: ArrayBuffer[];
  timings: PrecomputeTimings;
}

export interface PrecomputeTimings {
  bvhTimeMs: number;
  bvhBuildTimeMs: number;
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
      ((attrName === 'indices' ? new Uint32Array(attr.array)
        : attr.array.byteOffset !== 0 || attr.array.byteLength !== attr.array.buffer.byteLength
          ? attr.array.slice() : attr.array).buffer as ArrayBuffer);
    obj[attrName] = attr && {
      // Use Uint32Array for transferred indices
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
  texture.displacementDataCacheKey = transferred.cacheKey;
  return texture;
}

/**
 * Whether the mesh still needs geometry preparation or a BLAS build.
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
        const displacementMap = getMeshDisplacementMap(mesh);
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
    snapshots: rawMeshes.map((mesh, index) => ({
      geometry: mesh.geometry, version: mesh.geometry.version,
      cacheKey: getPreparedMeshGeometryCacheKey(mesh), bvh: geometries[index].bvh,
      displacementMap: getMeshDisplacementMap(mesh),
      displacementScale: getMeshDisplacementScale(mesh),
      displacementTextureKey: getMeshDisplacementMap(mesh)
        ? getDisplacementTextureDataCacheKey(getMeshDisplacementMap(mesh)!) : undefined
    })),
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
    trianglesDisplacement?: Float32Array
  ) => Promise<FlattendBVH>,
  onProgress?: (progress: PrecomputeProgress) => void,
  projectiveDisplacements: (
    | ProjectiveDisplacementForTransfer
    | undefined
  )[] = []
): Promise<PrecomputeResult> {
  const buffers: ArrayBuffer[] = [];
  const bvhBuildPromiseMap = new WeakMap<
    GeometryForTransfer,
    Promise<FlattendBVH>
  >();
  let completedBvhs = 0;
  const timings: PrecomputeTimings = {
    bvhTimeMs: 0,
    bvhBuildTimeMs: 0,
  };

  async function createBVH(
    geo: Geometry,
    displacementScale: number,
    trianglesDisplacementBuffer?: ArrayBuffer
  ) {
    const trianglesDisplacement = trianglesDisplacementBuffer
      ? new Float32Array(trianglesDisplacementBuffer)
      : undefined;
    try {
      const start = typeof performance === 'undefined' ? Date.now() : performance.now();
      const built = await (buildBVH && !geo.dynamic
        ? buildBVH(geo, displacementScale, trianglesDisplacement)
        : buildBLAS(geo, displacementScale, trianglesDisplacement));
      const measured = (built as FlattendBVH & { bvhTimeMs?: number }).bvhTimeMs ??
        (typeof performance === 'undefined' ? Date.now() : performance.now()) - start;
      timings.bvhTimeMs += measured;
      timings.bvhBuildTimeMs += measured;
      return built;
    } catch (e) {
      // An application-supplied builder is an explicit acceleration-structure
      // choice. Propagate its failure instead of silently substituting the
      // built-in builder or an empty BVH.
      if (buildBVH) throw e;
      console.error(e);
      // In case there are bad data.
      return emptyBLAS();
    }
  }
  const res = {
    geometries: await Promise.all(
      inGeometries.map(async (geometry, idx) => {
        const newGeo = convertGeometryFromTransfer(geometry);
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
        let bvh = newGeo.bvh;
        const displacementScale = displacementScales[idx];
        if (!bvh) {
          const bvhPromise = bvhBuildPromiseMap.get(geometry);
          if (bvhPromise) {
            bvh = await bvhPromise;
          } else {
            const promise = createBVH(
              newGeo,
              displacementScale,
              trianglesDisplacements[idx]
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
    const snapshot = preparedData.snapshots?.[idx];
    const mesh = preparedData.rawMeshes[idx];
    if (snapshot && (mesh.geometry !== snapshot.geometry ||
        mesh.geometry.version !== snapshot.version ||
        getPreparedMeshGeometryCacheKey(mesh) !== snapshot.cacheKey ||
        preparedData.rawGeometries[idx].bvh !== snapshot.bvh ||
        getMeshDisplacementMap(mesh) !== snapshot.displacementMap ||
        getMeshDisplacementScale(mesh) !== snapshot.displacementScale ||
        (snapshot.displacementMap && getDisplacementTextureDataCacheKey(snapshot.displacementMap) !==
          snapshot.displacementTextureKey))) return;
    preparedData.rawGeometries[idx].bvh = geo.bvh;
  });
}
