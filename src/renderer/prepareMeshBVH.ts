import { mat4, vec2, vec3 } from '../math';
import Geometry, { Attribute } from '../scene/Geometry';
import Mesh from '../scene/Mesh';
import OpenPBRMaterial from '../scene/OpenPBRMaterial';
import { uvProjectionConstants } from './MergedMaterialData';
import { buildBLAS, flattenBvh, TLASInstance } from './bvhAccel';
import Texture, { isTextureDataSource } from '../scene/Texture';
import { generateVertexTangents } from '../util/geometry';
import { tessellateDisplacementGeometry } from '../util/tessellateDisplacement';
import { colorLuminance } from './lightSampling';

function computeGeometryBounds(geometry: Geometry) {
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
  const bvh = geometry.bvh!;
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

// TODO ignore root node transform.
export function computeBounds(
  _geometry: Geometry,
  m: mat4.Mat4Array,
  bvhBounds: [vec3.Vec3Array, vec3.Vec3Array]
) {
  const min = vec3.fromValues(Infinity, Infinity, Infinity);
  const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
  const p = vec3.create();
  // Transforming the eight BLAS AABB corners is exact for an affine transform
  // and independent of mesh vertex count. The previous rotated path scanned
  // every vertex on every instance update.
  for (let corner = 0; corner < 8; corner++) {
    vec3.set(
      p,
      bvhBounds[(corner >> 0) & 1][0],
      bvhBounds[(corner >> 1) & 1][1],
      bvhBounds[(corner >> 2) & 1][2]
    );
    vec3.transformMat4(p, p, m);
    if (!p.every(isFinite)) continue;
    vec3.min(min, min, p);
    vec3.max(max, max, p);
  }

  return {
    min,
    max
  };
}

export interface PreparedMeshInstanceBinding {
  mesh: Mesh;
  geometry: Geometry;
  blasIndex: number;
  materialIndices: number[];
  displacementScale: number;
  bvhBounds: [vec3.Vec3Array, vec3.Vec3Array];
}

export function updateMeshInstanceTransforms(
  bindings: PreparedMeshInstanceBinding[],
  current?: TLASInstance[],
  dirtyIndices?: ReadonlySet<number>
) {
  const update = (
    {
      mesh,
      geometry,
      blasIndex,
      materialIndices,
      displacementScale,
      bvhBounds
    }: PreparedMeshInstanceBinding
  ) =>
    ({
      bounds: computeBounds(geometry, mesh.matrixWorld, bvhBounds),
      blasIndex,
      transform: mesh.matrixWorld,
      materialsIndices: materialIndices.map((idx) =>
        Geometry.packMaterialIndexAndWeightToInt(idx, 1)
      ),
      displacementScale,
      uvProjection: mesh.uvProjection == null ? -1 : uvProjectionConstants[mesh.uvProjection],
      displacementUvProjection: mesh.displacementUvProjection == null ? -1 : uvProjectionConstants[mesh.displacementUvProjection]
    }) satisfies TLASInstance;
  if (!current || !dirtyIndices) return bindings.map(update);
  const next = current.slice();
  dirtyIndices.forEach((index) => {
    const binding = bindings[index];
    if (binding) next[index] = update(binding);
  });
  return next;
}

/** Resolves CPU displacement settings without mutating a shared material. */
export function getMeshDisplacementMaterial(mesh: Mesh) {
  const material = mesh.materials[0];
  if (mesh.displacementUvProjection == null || mesh.displacementUvProjection === material.displacementUvProjection) return material;
  return Object.assign(new OpenPBRMaterial(), material, { displacementUvProjection: mesh.displacementUvProjection });
}

export function getMeshDisplacementMap(mesh: Mesh) {
  // Not support multiple materials for displacement.
  const material = getMeshDisplacementMaterial(mesh);
  return material.displacementMode === 'tessellated'
    ? undefined
    : material.displacementMap;
}

export function getMeshDisplacementScale(mesh: Mesh) {
  return mesh.materials[0].displacementScale;
}

const tessellatedGeometryCache = new WeakMap<Geometry, Map<string, Geometry>>();
let displacementGeometryId = 1;
const displacementGeometryIds = new WeakMap<Geometry, number>();
let displacementTextureId = 1;
const displacementTextureIds = new WeakMap<object, number>();

function getDisplacementTextureId(texture: Texture) {
  const identity = texture.source ?? texture;
  let id = displacementTextureIds.get(identity);
  if (id == null) {
    id = displacementTextureId++;
    displacementTextureIds.set(identity, id);
  }
  return id;
}

function getDisplacementGeometryId(geometry: Geometry) {
  let id = displacementGeometryIds.get(geometry);
  if (id == null) {
    id = displacementGeometryId++;
    displacementGeometryIds.set(geometry, id);
  }
  return id;
}

export function getDisplacementTextureDataCacheKey(texture: Texture) {
  const image = texture.image;
  return [
    getDisplacementTextureId(texture),
    texture.version,
    image.width,
    image.height
  ].join('|');
}

const maxEmissiveTessellationTriangles = 250_000;
const detailedProjectiveRangeTriangleLimit = 100_000;
const displacementMinmaxCache = new Map<string, Uint8Array[]>();

function displacementTriangleBudget(material: OpenPBRMaterial) {
  const isEmissive = !material.unlit &&
    colorLuminance(material.emissionColor) * material.emissionLuminance > 1e-8;
  return isEmissive
    ? Math.min(
        material.displacementMaxTriangles,
        maxEmissiveTessellationTriangles
      )
    : material.displacementMaxTriangles;
}

export function getMeshGeometrySimplificationRatio(mesh: Mesh) {
  return Math.min(Math.max(mesh.geometrySimplificationRatio ?? 1, 0), 1);
}

export function getPreparedMeshGeometryCacheKey(mesh: Mesh) {
  const source = mesh.geometry;
  const material = getMeshDisplacementMaterial(mesh);
  const texture = material?.displacementMap;
  if (!material) return undefined;
  const simplificationRatio = getMeshGeometrySimplificationRatio(mesh);
  const hasTessellatedDisplacement =
    material.displacementMode === 'tessellated' &&
    !!texture &&
    (Math.abs(material.displacementScale) > 1e-6 ||
      Math.abs(material.displacementBias) > 1e-6);
  if (!hasTessellatedDisplacement) {
    // Projective displacement bounds depend on projection, even when the
    // source attributes are shared. Keep a separate BLAS for each override.
    if (mesh.displacementUvProjection != null && texture && Math.abs(material.displacementScale) > 1e-6) {
      return ['projectiveProjection', source.version, getDisplacementTextureDataCacheKey(texture),
        +texture.flipY, texture.uvScale.join(','), texture.uvOffset.join(','),
        material.displacementScale, material.displacementUvScale, mesh.displacementUvProjection].join('|');
    }
    return simplificationRatio < 1
      ? ['meshopt', source.version, simplificationRatio].join('|')
      : undefined;
  }
  const displacementTexture = texture!;
  const triangleBudget = displacementTriangleBudget(material);
  return [
    source.version,
    getDisplacementTextureDataCacheKey(displacementTexture),
    +displacementTexture.flipY,
    displacementTexture.uvScale.join(','),
    displacementTexture.uvOffset.join(','),
    material.displacementScale,
    material.displacementBias,
    material.displacementUvProjection,
    material.displacementUvScale,
    material.displacementTessellationMode,
    material.displacementMinSubdivisionLevel,
    material.displacementMaxSubdivisionLevel,
    mesh.displacementFaceLevels?.length ?? 0,
    mesh.displacementFaceLevelsHash,
    material.displacementMaxError,
    material.displacementEdgeProfile,
    material.displacementThreshold,
    material.displacementEdgeWidth,
    +material.displacementHardContourGeometry,
    material.displacementContourSmoothing,
    material.displacementContourSubdivisionLevel,
    material.displacementCreaseAngle,
    material.displacementHeightFilter,
    +material.displacementHeightPrefilter,
    simplificationRatio,
    triangleBudget
  ].join('|');
}

export function getCachedPreparedMeshGeometry(mesh: Mesh) {
  const key = getPreparedMeshGeometryCacheKey(mesh);
  if (key == null) return mesh.geometry;
  const cached = tessellatedGeometryCache.get(mesh.geometry)?.get(key);
  if (!cached && key.startsWith('projectiveProjection|')) {
    return cachePreparedMeshGeometry(mesh, new Geometry(mesh.geometry));
  }
  return cached;
}

export function cachePreparedMeshGeometry(mesh: Mesh, generated: Geometry) {
  const key = getPreparedMeshGeometryCacheKey(mesh);
  if (key == null) return mesh.geometry;
  let entries = tessellatedGeometryCache.get(mesh.geometry);
  if (!entries) {
    entries = new Map();
    tessellatedGeometryCache.set(mesh.geometry, entries);
  }
  // A camera-derived face mask changes after zoom/orbit. Each generated mesh
  // can contain millions of triangles, so retaining four previous views can
  // exceed the browser heap even when the current result fits its budget.
  const maximumEntries = mesh.displacementFaceLevels ? 1 : 4;
  if (entries.size >= maximumEntries && !entries.has(key)) entries.clear();
  entries.set(key, generated);
  return generated;
}

export function getMeshDisplacementTessellationOptions(mesh: Mesh) {
  const material = getMeshDisplacementMaterial(mesh);
  const triangleBudget = displacementTriangleBudget(material);
  return {
    mode: material.displacementTessellationMode,
    minSubdivisionLevel: material.displacementMinSubdivisionLevel,
    faceSubdivisionLevels: mesh.displacementFaceLevels,
    maxSubdivisionLevel: material.displacementMaxSubdivisionLevel,
    maxError: material.displacementMaxError,
    maxTriangles: triangleBudget,
    displacementScale: material.displacementScale,
    displacementBias: material.displacementBias,
    uvProjection: material.displacementUvProjection,
    uvScale: material.displacementUvScale,
    edgeProfile: material.displacementEdgeProfile,
    threshold: material.displacementThreshold,
    edgeWidth: material.displacementEdgeWidth,
    hardContourGeometry: material.displacementHardContourGeometry,
    contourSmoothing: material.displacementContourSmoothing,
    contourSubdivisionLevel: material.displacementContourSubdivisionLevel,
    creaseAngle: material.displacementCreaseAngle,
    heightFilter: material.displacementHeightFilter,
    heightPrefilter: material.displacementHeightPrefilter,
    simplificationRatio: getMeshGeometrySimplificationRatio(mesh),
    topologyCacheKey:
      (
        material.displacementTessellationMode === 'uniform' ||
        material.displacementTessellationMode === 'opensubdiv'
      )
        ? [
            getDisplacementGeometryId(mesh.geometry),
            mesh.geometry.version,
            material.displacementTessellationMode,
            material.displacementMinSubdivisionLevel,
            material.displacementMaxSubdivisionLevel,
            mesh.displacementFaceLevels?.length ?? 0,
            mesh.displacementFaceLevelsHash,
            triangleBudget
          ].join('|')
        : undefined
  };
}

/**
 * Returns the source mesh geometry, or its cached optimized/evaluated mesh.
 * The renderer may temporarily keep the source geometry while an async-only
 * OpenSubdiv build is pending; direct synchronous callers still receive the
 * explicit error from tessellateDisplacementGeometry().
 */
export function getPreparedMeshGeometry(
  mesh: Mesh,
  { allowAsyncTessellationFallback = false }: {
    allowAsyncTessellationFallback?: boolean;
  } = {}
) {
  const source = mesh.geometry;
  const material = getMeshDisplacementMaterial(mesh);
  const texture = material?.displacementMap;
  const key = getPreparedMeshGeometryCacheKey(mesh);
  if (key == null) return source;
  if (key.startsWith('projectiveProjection|')) return getCachedPreparedMeshGeometry(mesh)!;
  let entries = tessellatedGeometryCache.get(source);
  if (!entries) {
    entries = new Map();
    tessellatedGeometryCache.set(source, entries);
  }
  const cached = entries.get(key);
  if (cached) return cached;
  const hasTessellatedDisplacement =
    material.displacementMode === 'tessellated' &&
    !!texture &&
    (Math.abs(material.displacementScale) > 1e-6 ||
      Math.abs(material.displacementBias) > 1e-6);
  if (!hasTessellatedDisplacement) return source;
  if (!source.normal) computeGeometryNormals(source);
  if (
    allowAsyncTessellationFallback &&
    material.displacementTessellationMode === 'opensubdiv'
  ) {
    return source;
  }
  const generated = tessellateDisplacementGeometry(
    source,
    texture!,
    getMeshDisplacementTessellationOptions(mesh)
  );
  return cachePreparedMeshGeometry(mesh, generated);
}

export function computeMinmaxCPU(
  _geometry: Geometry,
  heightImage: Texture['image']
) {
  const w = heightImage.width;
  const minmaxData: Uint8Array[] = [];
  const maxMipLevel = Math.log2(w);
  let heightPixels: ArrayLike<number>;
  let sourceChannels: number;
  let normalizeHeight: (value: number) => number;
  if (isTextureDataSource(heightImage)) {
    heightPixels = heightImage.data;
    sourceChannels = Math.max(
      1,
      Math.floor(heightImage.data.length / (heightImage.width * heightImage.height))
    );
    const normalized =
      heightImage.data instanceof Uint8Array ||
      heightImage.data instanceof Uint8ClampedArray;
    normalizeHeight = normalized
      ? (value) => value
      : (value) => Math.round(Math.min(Math.max(value, 0), 1) * 255);
  } else {
    if (typeof document === 'undefined') {
      throw new Error('The displacement texture is not CPU-readable.');
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = w;
    canvas.height = w;
    ctx.drawImage(heightImage, 0, 0, w, w);
    heightPixels = ctx.getImageData(0, 0, w, w).data;
    sourceChannels = 4;
    normalizeHeight = (value) => value;
  }
  let mipmapSize = w;
  for (let lod = 0; lod <= maxMipLevel; lod++) {
    const prevMinmaxData = minmaxData[Math.max(0, lod - 1)];
    const minmax = new Uint8Array(mipmapSize * mipmapSize * 2);
    minmaxData.push(minmax);
    const channels = lod === 0 ? sourceChannels : 2;
    for (let y = 0; y < mipmapSize; y++) {
      for (let x = 0; x < mipmapSize; x++) {
        const yx = y * mipmapSize + x;
        const idx = yx * channels;
        let min = 0;
        let max = 0;
        if (lod == 0) {
          min = normalizeHeight(heightPixels[idx]);
          max = min;
          if (y < mipmapSize - 1 && x < mipmapSize - 1) {
            const h = normalizeHeight(
              heightPixels[idx + (mipmapSize + 1) * channels]
            );
            min = Math.min(min, h);
            max = Math.max(max, h);
          }
          if (y < mipmapSize - 1) {
            const h = normalizeHeight(heightPixels[idx + mipmapSize * channels]);
            min = Math.min(min, h);
            max = Math.max(max, h);
          }
          if (x < mipmapSize - 1) {
            const h = normalizeHeight(heightPixels[idx + channels]);
            min = Math.min(min, h);
            max = Math.max(max, h);
          }
        } else {
          const x2 = x * 2;
          const y2 = y * 2;
          const prevMipmapSize = mipmapSize * 2;
          const idx2 = (y2 * prevMipmapSize + x2) * channels;
          const idx2_0 = idx2;
          const idx2_1 = idx2 + channels;
          const idx2_2 = idx2 + prevMipmapSize * channels;
          const idx2_3 = idx2 + prevMipmapSize * channels + channels;
          min = Math.min(
            prevMinmaxData[idx2_0],
            prevMinmaxData[idx2_1],
            prevMinmaxData[idx2_2],
            prevMinmaxData[idx2_3]
          );
          max = Math.max(
            prevMinmaxData[idx2_0 + 1],
            prevMinmaxData[idx2_1 + 1],
            prevMinmaxData[idx2_2 + 1],
            prevMinmaxData[idx2_3 + 1]
          );
        }
        minmax[yx * 2] = min;
        minmax[yx * 2 + 1] = max;
      }
    }
    mipmapSize = mipmapSize / 2;
  }

  return minmaxData;
}

function sphericalProjection(n: vec3.Vec3Array, uv: vec2.Vec2Array) {
  const theta = Math.atan2(n[0], n[2]) / (2.0 * Math.PI) + 0.5;
  const phi = Math.acos(n[1]) / Math.PI;
  vec2.set(uv, theta, 1.0 - phi);
}

export function sphericalProjectionTriangle(
  na: vec3.Vec3Array,
  nb: vec3.Vec3Array,
  nc: vec3.Vec3Array,
  uvA: vec2.Vec2Array,
  uvB: vec2.Vec2Array,
  uvC: vec2.Vec2Array
) {
  sphericalProjection(na, uvA);
  sphericalProjection(nb, uvB);
  sphericalProjection(nc, uvC);
  let onSeam = false;
  for (let i = 0; i < 2; i++) {
    if (
      Math.abs(uvA[i] - uvB[i]) > 0.5 ||
      Math.abs(uvA[i] - uvC[i]) > 0.5 ||
      Math.abs(uvB[i] - uvC[i]) > 0.5
    ) {
      const maxU = Math.max(uvA[i], uvB[i], uvC[i]);
      if (maxU - uvA[i] > 0.5) {
        uvA[i] += 1.0;
        onSeam = true;
      }
      if (maxU - uvB[i] > 0.5) {
        uvB[i] += 1.0;
        onSeam = true;
      }
      if (maxU - uvC[i] > 0.5) {
        uvC[i] += 1.0;
        onSeam = true;
      }
    }
  }

  return onSeam;
}

function getMaxAxisIndex(n: vec3.Vec3Array) {
  const x = Math.abs(n[0]);
  const y = Math.abs(n[1]);
  const z = Math.abs(n[2]);
  return x > y && x > z ? 0 : y > z ? 1 : 2;
}

export function triplanarProjectionTriangle(
  a: vec3.Vec3Array,
  b: vec3.Vec3Array,
  c: vec3.Vec3Array,
  na: vec3.Vec3Array,
  nb: vec3.Vec3Array,
  nc: vec3.Vec3Array,
  uvA: vec2.Vec2Array,
  uvB: vec2.Vec2Array,
  uvC: vec2.Vec2Array
) {
  const tmpMaxX = Math.max(Math.abs(na[0]), Math.abs(nb[0]), Math.abs(nc[0]));
  const tmpMaxY = Math.max(Math.abs(na[1]), Math.abs(nb[1]), Math.abs(nc[1]));
  const tmpMaxZ = Math.max(Math.abs(na[2]), Math.abs(nb[2]), Math.abs(nc[2]));

  if (tmpMaxX > tmpMaxY && tmpMaxX > tmpMaxZ) {
    // yz
    vec2.set(uvA, a[1], a[2]);
    vec2.set(uvB, b[1], b[2]);
    vec2.set(uvC, c[1], c[2]);
  } else if (tmpMaxY > tmpMaxX && tmpMaxY > tmpMaxZ) {
    // xz
    vec2.set(uvA, a[0], a[2]);
    vec2.set(uvB, b[0], b[2]);
    vec2.set(uvC, c[0], c[2]);
  } else {
    // xy
    vec2.set(uvA, a[0], a[1]);
    vec2.set(uvB, b[0], b[1]);
    vec2.set(uvC, c[0], c[1]);
  }
}

function findRoots(
  triAabbMinP: vec2.Vec2Array,
  triAabbMaxP: vec2.Vec2Array,
  maxDepth: number,
  roots: vec3.Vec3Array[]
) {
  let d = vec2.sub(vec2.create(), triAabbMaxP, triAabbMinP);
  let size = Math.max(d[0], d[1]);
  let startMipLevel =
    maxDepth - Math.floor(Math.log2(Math.floor(1.0 / size))) - 1;
  if (!isFinite(startMipLevel)) {
    startMipLevel = maxDepth;
  }
  startMipLevel = Math.max(startMipLevel, 0);
  let rootCount = 0;
  while (true) {
    const mipSize = Math.pow(2.0, maxDepth - startMipLevel);
    const minTexelX = Math.floor(mipSize * triAabbMinP[0]);
    const minTexelY = Math.floor(mipSize * triAabbMinP[1]);
    const maxTexelX = Math.floor(mipSize * triAabbMaxP[0]);
    const maxTexelY = Math.floor(mipSize * triAabbMaxP[1]);

    if (
      (maxTexelX - minTexelX < 2 &&
        maxTexelY - minTexelY < 2 &&
        startMipLevel >= 0) ||
      startMipLevel >= maxDepth
    ) {
      for (let y = minTexelY; y <= maxTexelY; y++) {
        for (let x = minTexelX; x <= maxTexelX; x++) {
          if (rootCount < roots.length) {
            vec3.set(
              roots[rootCount],
              Math.floor(x),
              Math.floor(y),
              startMipLevel
            );
            rootCount++;
          }
        }
      }
      break;
    }

    startMipLevel++;
  }

  return rootCount;
}

export function getTrianglesDisplacementRange(
  geometry: Geometry,
  heightTexture: Texture | undefined,
  material: OpenPBRMaterial
) {
  const indices = geometry.indices.array;
  const uvs = geometry.uv?.array;
  const uvProjection = material.displacementUvProjection;
  if (!heightTexture) return;
  if (!uvs && uvProjection === 'none') {
    throw new Error(
      'UV displacement requires texture coordinates; use triplanar, spherical, or cylindrical projection for a UV-less mesh.'
    );
  }
  const heightImage = heightTexture.image;
  const isFlipY = heightTexture.flipY;
  if (!heightImage.width || !heightImage.height) {
    return;
  }
  const triangleCount = indices.length / 3;
  if (triangleCount >= detailedProjectiveRangeTriangleLimit) {
    // A conservative full-height prism is much cheaper to prepare for dense
    // source meshes and remains intersection-safe. Per-triangle UV min/max is
    // retained for smaller meshes where tighter BVH nodes matter more.
    const conservative = new Float32Array(triangleCount * 2);
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      conservative[triangle * 2 + 1] = 1;
    }
    return conservative;
  }
  const minmaxCacheKey =
    heightTexture.tessellationCacheKey ??
    getDisplacementTextureDataCacheKey(heightTexture);
  let minmaxData = displacementMinmaxCache.get(minmaxCacheKey);
  if (!minmaxData) {
    minmaxData = computeMinmaxCPU(geometry, heightImage);
    if (displacementMinmaxCache.size >= 4) {
      displacementMinmaxCache.delete(
        displacementMinmaxCache.keys().next().value!
      );
    }
    displacementMinmaxCache.set(minmaxCacheKey, minmaxData);
  }

  const maxDepth = Math.log2(heightImage.width);
  const trianglesDisplacementRange = new Float32Array((indices.length / 3) * 2);
  const normal = geometry.normal!.array;
  const position = geometry.position!.array;

  const uv1 = vec2.create();
  const uv2 = vec2.create();
  const uv3 = vec2.create();

  const p1 = vec3.create();
  const p2 = vec3.create();
  const p3 = vec3.create();

  const n1 = vec3.create();
  const n2 = vec3.create();
  const n3 = vec3.create();

  const isTriplanar = uvProjection === 'triplanar';
  const isSpherical = uvProjection === 'spherical';
  const isCylindrical = uvProjection === 'cylindrical';
  const uvScale = material.displacementUvScale;

  const minUv = vec2.create();
  const maxUv = vec2.create();

  const roots: vec3.Vec3Array[] = [];
  for (let i = 0; i < 100; i++) {
    roots.push([0, 0, 0]);
  }
  for (let i = 0; i < indices.length; i += 3) {
    const i1 = indices[i];
    const i2 = indices[i + 1];
    const i3 = indices[i + 2];
    const i1_2 = i1 * 2;
    const i2_2 = i2 * 2;
    const i3_2 = i3 * 2;
    const i1_3 = i1 * 3;
    const i2_3 = i2 * 3;
    const i3_3 = i3 * 3;

    if (uvs) {
      vec2.set(uv1, uvs[i1_2], uvs[i1_2 + 1]);
      vec2.set(uv2, uvs[i2_2], uvs[i2_2 + 1]);
      vec2.set(uv3, uvs[i3_2], uvs[i3_2 + 1]);
    } else {
      vec2.set(uv1, 0, 0);
      vec2.set(uv2, 0, 0);
      vec2.set(uv3, 0, 0);
    }

    let onSeam = false;
    if (isTriplanar || isSpherical || isCylindrical) {
      vec3.set(n1, normal[i1_3], normal[i1_3 + 1], normal[i1_3 + 2]);
      vec3.set(n2, normal[i2_3], normal[i2_3 + 1], normal[i2_3 + 2]);
      vec3.set(n3, normal[i3_3], normal[i3_3 + 1], normal[i3_3 + 2]);
      vec3.normalize(n1, n1);
      vec3.normalize(n2, n2);
      vec3.normalize(n3, n3);
      if (isTriplanar || isSpherical || isCylindrical) {
        vec3.set(p1, position[i1_3], position[i1_3 + 1], position[i1_3 + 2]);
        vec3.set(p2, position[i2_3], position[i2_3 + 1], position[i2_3 + 2]);
        vec3.set(p3, position[i3_3], position[i3_3 + 1], position[i3_3 + 2]);
      }
      if (isTriplanar) {
        // Is on the seam. Needs full prism to avoid empty seams.
        const xMaxIndex = getMaxAxisIndex(n1);
        const yMaxIndex = getMaxAxisIndex(n2);
        const zMaxIndex = getMaxAxisIndex(n3);
        if (!(xMaxIndex === yMaxIndex && yMaxIndex === zMaxIndex)) {
          onSeam = true;
        }
        /* prettier-ignore */
        triplanarProjectionTriangle(
          p1, p2, p3,
          n1, n2, n3,
          uv1, uv2, uv3
        );
      } else if (isSpherical) {
        vec3.normalize(p1, p1);
        vec3.normalize(p2, p2);
        vec3.normalize(p3, p3);
        onSeam = sphericalProjectionTriangle(p1, p2, p3, uv1, uv2, uv3);
      } else {
        const u1 = Math.atan2(p1[2], p1[0]) / (Math.PI * 2) + 0.5;
        const u2 = Math.atan2(p2[2], p2[0]) / (Math.PI * 2) + 0.5;
        const u3 = Math.atan2(p3[2], p3[0]) / (Math.PI * 2) + 0.5;
        vec2.set(uv1, u1, p1[1]);
        vec2.set(uv2, u2, p2[1]);
        vec2.set(uv3, u3, p3[1]);
        onSeam = Math.max(u1, u2, u3) - Math.min(u1, u2, u3) > 0.5;
      }
    }
    vec2.scale(uv1, uv1, uvScale);
    vec2.scale(uv2, uv2, uvScale);
    vec2.scale(uv3, uv3, uvScale);

    // TODO PDM don't have zero area triangle issue.
    // if (triangleArea(uv1, uv2, uv3) === 0) {
    //   // minHeight and maxHeight will be 0.
    //   continue;
    // }

    let minHeight = Infinity;
    let maxHeight = -Infinity;

    if (onSeam) {
      minHeight = 0.0;
      maxHeight = 255.0;
    } else {
      vec2.copy(maxUv, uv1);
      vec2.copy(minUv, uv1);
      vec2.min(minUv, minUv, uv2);
      vec2.min(minUv, minUv, uv3);
      vec2.max(maxUv, maxUv, uv2);
      vec2.max(maxUv, maxUv, uv3);

      const rootCount = findRoots(minUv, maxUv, maxDepth, roots);

      for (let k = 0; k < rootCount; k++) {
        const mipLevel = roots[k][2];
        const mipSize = Math.pow(2, maxDepth - mipLevel);
        const minmax = minmaxData[mipLevel];
        const x = ((roots[k][0] % mipSize) + mipSize) % mipSize;
        let y = ((roots[k][1] % mipSize) + mipSize) % mipSize;
        if (isFlipY) {
          y = mipSize - y - 1;
        }
        const idx = (y * mipSize + x) * 2;

        minHeight = Math.min(minHeight, minmax[idx]);
        maxHeight = Math.max(maxHeight, minmax[idx + 1]);
      }
    }

    // TODO this will cause flat surface optimization fail.
    // But not adding bias will leads to small gap between flat surface and displaced surface.
    trianglesDisplacementRange[(i / 3) * 2] = Math.max(
      (Math.floor(minHeight) - 4) / 255,
      0
    );
    trianglesDisplacementRange[(i / 3) * 2 + 1] = Math.min(
      (Math.ceil(maxHeight) + 4) / 255,
      1
    );
  }

  return trianglesDisplacementRange;
}

function prepareMeshGeometryBvh(mesh: Mesh) {
  const geometry = getPreparedMeshGeometry(mesh, {
    allowAsyncTessellationFallback: true
  });
  if (!geometry.normal) computeGeometryNormals(geometry);
  if (!geometry.tangent && geometry.uv) generateVertexTangents(geometry);
  const heightMap = getMeshDisplacementMap(mesh);
  const displacementScale = heightMap ? getMeshDisplacementScale(mesh) : 0;
  if (geometry.dynamic && geometry.bvh?.builder !== 'builtin') geometry.bvh = undefined;
  if (!geometry.bvh) {
    const trianglesDisplacement =
      Math.abs(displacementScale) > 1e-6
        ? getTrianglesDisplacementRange(geometry, heightMap, getMeshDisplacementMaterial(mesh))
        : undefined;
    geometry.bvh = flattenBvh(
      buildBLAS(geometry, displacementScale, trianglesDisplacement),
      false,
      trianglesDisplacement
    );
  }
  return { geometry, displacementScale };
}

export function updateMeshInstances(meshes: Mesh[]) {
  const materialIndexMap = new Map<OpenPBRMaterial, number>();
  const geometryIndexMap = new Map<Geometry, number>();
  const geometries: Geometry[] = [];
  const materials: OpenPBRMaterial[] = [];
  const globalMaterialIndicesMap: number[][] = [];
  const emissiveBindings: {
    mesh: Mesh;
    geometry: Geometry;
    materialIndices: number[];
  }[] = [];
  const instanceBindings: PreparedMeshInstanceBinding[] = [];


  const instances = meshes
    .filter((mesh) => mesh.geometry.position.array.length > 0)
    .map((mesh) => {
      let { geometry, displacementScale } = prepareMeshGeometryBvh(mesh);
      const bvhBounds = getBvhBounds(geometry);
      const bounds = computeBounds(geometry, mesh.matrixWorld, bvhBounds);

      let geoIdx = geometryIndexMap.get(geometry);
      if (
        geoIdx != null &&
        mesh.materials.length > 1 &&
        geometry.materialIndex
      ) {
        const bvh = geometry.bvh;
        // TODO geometry with multiple materials donesn't allow sharing between instances.
        // Need to clone the geometry.
        geometry = new Geometry(geometry);
        geometry.bvh = bvh;
        geoIdx = undefined;
      }

      const materialsIndices = mesh.materials.map((material) => {
        const key = material;
        if (!materialIndexMap.has(key)) {
          materialIndexMap.set(key, materials.length);
          materials.push(material);
        }
        return materialIndexMap.get(key)!;
      });

      if (geoIdx == null) {
        geoIdx = geometries.length;
        geometryIndexMap.set(geometry, geometries.length);
        geometries.push(geometry);
        // Same number with geometries.
        globalMaterialIndicesMap.push(materialsIndices);
      }
      const instance = {
        bounds,
        blasIndex: geoIdx!,
        transform: mesh.matrixWorld,
        materialsIndices: materialsIndices.map((idx) =>
          Geometry.packMaterialIndexAndWeightToInt(idx, 1)
        ),
        displacementScale,
        uvProjection: mesh.uvProjection == null ? -1 : uvProjectionConstants[mesh.uvProjection],
        displacementUvProjection: mesh.displacementUvProjection == null ? -1 : uvProjectionConstants[mesh.displacementUvProjection]
      } satisfies TLASInstance;
      if (
        !bounds.min.every(isFinite) ||
        !bounds.max.every(isFinite) ||
        !mesh.matrixWorld.every(isFinite)
      ) {
        return undefined;
      }
      if (mesh.materials.some((material) =>
        !material.unlit && !material.shadowCatcher &&
        colorLuminance(material.emissionColor) * material.emissionLuminance > 1e-8
      )) {
        emissiveBindings.push({ mesh, geometry, materialIndices: materialsIndices });
      }
      instanceBindings.push({
        mesh,
        geometry,
        blasIndex: geoIdx,
        materialIndices: materialsIndices,
        displacementScale,
        bvhBounds
      });
      return instance;
    })
    .filter((instance) => instance != null) as TLASInstance[];

  const geometryRegions = new Map<Geometry, { vertexOffset: number; indexOffset: number; materialIndices: number[] }>();
  const geometry = mergeGeometry(geometries, globalMaterialIndicesMap, geometryRegions);

  return {
    geometry,
    geometries,
    geometryRegions,
    instances,
    materials,
    instanceBindings,
    emissiveBindings,
    blases: geometries.map((geo) => ({
      bvh: geo.bvh!,
      verticesCount: Geometry.getVertexCount(geo),
      trainglesCount: geo.indices.array.length / 3
    }))
  };
  // return { instances, geometries, globalMaterialIndicesMap, materials };
}

function mergeGeometry(
  geometries: Geometry[],
  globalMaterialIndicesMap: number[][],
  regions: Map<Geometry, { vertexOffset: number; indexOffset: number; materialIndices: number[] }>
) {
  const totalVertexCount = geometries.reduce(
    (sum, geo) => sum + Geometry.getVertexCount(geo),
    0
  );
  const totalIndexCount = geometries.reduce(
    (sum, geo) => sum + geo.indices.array.length,
    0
  );
  const positionAttrib = new Attribute(
    new Float32Array(3 * totalVertexCount),
    3
  );
  const normalAttrib = new Attribute(new Float32Array(3 * totalVertexCount), 3);
  const uvAttrib = new Attribute(new Float32Array(2 * totalVertexCount), 2);
  const uv1Attrib = new Attribute(new Float32Array(2 * totalVertexCount), 2);
  const indexAttrib = new Attribute(new Uint32Array(totalIndexCount), 1);

  const materialIndexAttrib = new Attribute(
    new Int32Array(4 * totalVertexCount),
    4
  );

  const hasColor = geometries.some((geo) => geo.color);
  const hasTangent = geometries.some((geo) => geo.tangent);

  const mergedGeometry = new Geometry({
    position: positionAttrib,
    normal: normalAttrib,
    uv: uvAttrib,
    uv1: uv1Attrib,
    materialIndex: materialIndexAttrib,
    color: hasColor
      ? new Attribute(new Float32Array(3 * totalVertexCount), 3)
      : undefined,
    tangent: hasTangent
      ? new Attribute(new Float32Array(3 * totalVertexCount), 3)
      : undefined,
    indices: indexAttrib
  });

  let currentVertex = 0;
  let currentIndex = 0;

  geometries.forEach((geometry, idx) => {
    const vertexCount = Geometry.getVertexCount(geometry);
    const globalMaterialIndex = globalMaterialIndicesMap[idx];
    regions.set(geometry, { vertexOffset: currentVertex, indexOffset: currentIndex, materialIndices: globalMaterialIndex });

    positionAttrib.array.set(geometry.position!.array, currentVertex * 3);
    normalAttrib.array.set(geometry.normal!.array, currentVertex * 3);
    if (geometry.uv) {
      uvAttrib.array.set(geometry.uv.array, currentVertex * 2);
    }
    uv1Attrib.array.set(
      (geometry.uv1 ?? geometry.uv)?.array ?? new Float32Array(vertexCount * 2),
      currentVertex * 2
    );
    if (geometry.color) {
      mergedGeometry.color!.array.set(geometry.color.array, currentVertex * 3);
    }
    if (geometry.tangent) {
      mergedGeometry.tangent!.array.set(
        geometry.tangent.array,
        currentVertex * 3
      );
    }

    const mergedMaterialIndex = materialIndexAttrib.array;
    if (geometry.materialIndex) {
      const values = geometry.materialIndex.array;
      for (let i = 0; i < vertexCount; i++) {
        for (let k = 0; k < 4; k++) {
          let hasMaterial = false;
          const localIdx = values[i * 4 + k];
          const off = (currentVertex + i) * 4 + k;
          if (localIdx > 0) {
            const res = Geometry.unpackMaterialIndexAndWeightFromInt(localIdx);
            // TODO handle invalid
            const globalIndex = globalMaterialIndex[res[0]] ?? 0;

            // TODO normalize weight to 1.
            if (globalIndex >= 0) {
              mergedMaterialIndex[off] =
                Geometry.packMaterialIndexAndWeightToInt(globalIndex, res[1]);
              hasMaterial = true;
            }
          }
          if (!hasMaterial) {
            mergedMaterialIndex[off] = 0;
          }
        }
      }
    }

    const meshIndices = geometry.indices.array;
    for (let i = 0; i < meshIndices.length; i++) {
      indexAttrib.array[currentIndex + i] = currentVertex + meshIndices[i];
    }
    currentVertex += vertexCount;
    currentIndex += meshIndices.length;
  });

  return mergedGeometry;
}

function computeGeometryNormals(geometry: Geometry) {
  const indices = geometry.indices;
  const positions = geometry.position.array;
  geometry.normal = new Attribute(new Float32Array(positions.length), 3);
  const normals = geometry.normal.array;

  const p1 = vec3.create();
  const p2 = vec3.create();
  const p3 = vec3.create();

  const v21 = vec3.create();
  const v32 = vec3.create();

  const n = vec3.create();

  const len = indices
    ? indices.array.length
    : Geometry.getVertexCount(geometry);
  let i1, i2, i3;
  for (let f = 0; f < len; ) {
    if (indices) {
      i1 = indices.array[f++];
      i2 = indices.array[f++];
      i3 = indices.array[f++];
    } else {
      i1 = f++;
      i2 = f++;
      i3 = f++;
    }

    vec3.set(
      p1,
      positions[i1 * 3],
      positions[i1 * 3 + 1],
      positions[i1 * 3 + 2]
    );
    vec3.set(
      p2,
      positions[i2 * 3],
      positions[i2 * 3 + 1],
      positions[i2 * 3 + 2]
    );
    vec3.set(
      p3,
      positions[i3 * 3],
      positions[i3 * 3 + 1],
      positions[i3 * 3 + 2]
    );

    vec3.sub(v21, p1, p2);
    vec3.sub(v32, p2, p3);
    vec3.cross(n, v21, v32);
    // Already be weighted by the triangle area
    for (let i = 0; i < 3; i++) {
      normals[i1 * 3 + i] = normals[i1 * 3 + i] + n[i];
      normals[i2 * 3 + i] = normals[i2 * 3 + i] + n[i];
      normals[i3 * 3 + i] = normals[i3 * 3 + i] + n[i];
    }
  }

  for (let i = 0; i < normals.length; ) {
    vec3.set(n, normals[i], normals[i + 1], normals[i + 2]);
    vec3.normalize(n, n);
    normals[i++] = n[0];
    normals[i++] = n[1];
    normals[i++] = n[2];
  }
}
