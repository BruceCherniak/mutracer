import InstancedMesh from '../scene/InstancedMesh.js';
import { meshInstanceCount, meshInstanceTransform, PackedMeshInstances, type MeshInstances } from './meshInstances.js';
import {createCanvas} from '../util/canvas.js';
import { packMaterialIndexAndWeightToInt } from './materialIndices.js';
import { getGeometryBvh, setGeometryBvh, geometryBvhConfigMatches, type BvhBuildConfig } from './geometryBvh.js';
import { writeMaterialIndices } from './materialIndices.js';
import { mat4, vec2, vec3 } from '../math.js';
import Geometry, { Attribute } from '../scene/Geometry.js';
import Mesh from '../scene/Mesh.js';
import OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import { buildBLAS, TLASInstance } from './bvhAccel.js';
import { colorLuminance } from './lightSampling.js';
import Texture, { isTextureDataSource } from '../scene/Texture.js';
import { generateVertexTangents, hasGeneratedVertexTangents } from '../util/geometry.js';

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

export function computeBounds(
  _geometry: Geometry,
  m: mat4.Mat4Array,
  bvhBounds: [vec3.Vec3Array, vec3.Vec3Array],
  result = {min: vec3.create(), max: vec3.create()},
  p = vec3.create()
) {
  const {min, max} = result;
  vec3.set(min, Infinity, Infinity, Infinity);
  vec3.set(max, -Infinity, -Infinity, -Infinity);
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

  return result;
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
  current?: MeshInstances,
  dirtyIndices?: ReadonlySet<number>
) {
  if (bindings.some(binding => binding.mesh instanceof InstancedMesh)) {
    const packed = new PackedMeshInstances(bindings.reduce((count, binding) => count + meshInstanceCount(binding.mesh), 0));
    const matrix = Array(16).fill(0) as mat4.Mat4Array;
    const boundsScratch = {min: vec3.create(), max: vec3.create()}, pointScratch = vec3.create();
    let sourceIndex = 0;
    for (const binding of bindings) {
      const {mesh, geometry, bvhBounds, blasIndex, materialIndices, displacementScale} = binding;
      for (let i = 0; i < meshInstanceCount(mesh); i++, sourceIndex++) {
        meshInstanceTransform(mesh, i, matrix);
        const bounds = computeBounds(geometry, matrix, bvhBounds, boundsScratch, pointScratch);
        if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite) || !matrix.every(Number.isFinite)) continue;
        const index = packed.length++;
        packed.sourceIndices[index] = sourceIndex;
        packed.transforms.set(matrix, index * 16);
        packed.bounds.set(bounds.min, index * 6); packed.bounds.set(bounds.max, index * 6 + 3);
        packed.blasIndices[index] = blasIndex; packed.materials[index] = packMaterialIndexAndWeightToInt(materialIndices[0], 1);
        packed.displacement[index] = displacementScale;
        const colors = mesh instanceof InstancedMesh ? mesh.colors : undefined;
        for (let k = 0; k < 3; k++) packed.colors[index * 3 + k] = colors?.[i * 3 + k] ?? 1;
      }
    }
    return packed;
  }
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
      bounds: computeBounds(geometry, mesh.transform, bvhBounds),
      blasIndex,
      transform: mesh.transform,
      materialsIndices: materialIndices.map((idx) =>
        packMaterialIndexAndWeightToInt(idx, 1)
      ),
      displacementScale
    }) satisfies TLASInstance;
  if (!current || !dirtyIndices) return bindings.map(update);
  const next = (current as TLASInstance[]).slice();
  dirtyIndices.forEach((index) => {
    const binding = bindings[index];
    if (binding) next[index] = update(binding);
  });
  return next;
}

/** Returns the first material used for CPU displacement. */
export function getMeshDisplacementMaterial(mesh: Mesh) {
  return mesh.materials[0];
}

export function getMeshDisplacementMap(mesh: Mesh) {
  // Not support multiple materials for displacement.
  const material = getMeshDisplacementMaterial(mesh);
  return material.displacementMap;
}

export function getMeshDisplacementScale(mesh: Mesh) {
  return mesh.materials[0].displacementScale;
}

const preparedGeometryCache = new WeakMap<Geometry, Map<string, Geometry>>();
let displacementTextureId = 1;
const displacementTextureIds = new WeakMap<object, number>();

function getDisplacementResourceId(identity: object) {
  let id = displacementTextureIds.get(identity);
  if (id == null) {
    id = displacementTextureId++;
    displacementTextureIds.set(identity, id);
  }
  return id;
}

export function getDisplacementTextureDataCacheKey(texture: Texture) {
  const image = texture.image;
  return [
    getDisplacementResourceId(texture.source ?? texture),
    getDisplacementResourceId(image),
    texture.version,
    image.width,
    image.height
  ].join('|');
}

const detailedProjectiveRangeTriangleLimit = 100_000;
const displacementMinmaxCache = new Map<string, Uint8Array[]>();

export function getPreparedMeshGeometryCacheKey(mesh: Mesh) {
  const source = mesh.geometry;
  const material = getMeshDisplacementMaterial(mesh);
  const texture = material?.displacementMap;
  if (!material) return undefined;
  // UV and procedural displacement both need height-aware BLAS bounds and
  // packed triangle ranges. Never reuse the source's undisplaced tree, or a
  // different material's height field, when a texture/scale changes.
  if (texture && Math.abs(material.displacementScale) > 1e-6) {
    return ['displacement', source.version, getDisplacementTextureDataCacheKey(texture),
      +texture.flipY, texture.uvScale.join(','), texture.uvOffset.join(','), texture.uvChannel,
      material.displacementScale, material.displacementUvProjectionScale, material.displacementUvProjection].join('|');
  }
  return undefined;
}

export function getCachedPreparedMeshGeometry(mesh: Mesh) {
  const key = getPreparedMeshGeometryCacheKey(mesh);
  if (key == null) return mesh.geometry;
  const cached = preparedGeometryCache.get(mesh.geometry)?.get(key);
  if (!cached) {
    const geometry = new Geometry(mesh.geometry);
    geometry.dynamic = mesh.geometry.dynamic;
    geometry.version = mesh.geometry.version;
    return cachePreparedMeshGeometry(mesh, geometry);
  }
  return cached;
}

export function cachePreparedMeshGeometry(mesh: Mesh, generated: Geometry) {
  const key = getPreparedMeshGeometryCacheKey(mesh);
  if (key == null) return mesh.geometry;
  let entries = preparedGeometryCache.get(mesh.geometry);
  if (!entries) {
    entries = new Map();
    preparedGeometryCache.set(mesh.geometry, entries);
  }
  if (entries.size >= 4 && !entries.has(key)) entries.clear();
  entries.set(key, generated);
  return generated;
}

/** Returns cached prepared geometry, or the source while asynchronous preparation is pending. */
export function getPreparedMeshGeometry(mesh: Mesh) {
  return getCachedPreparedMeshGeometry(mesh) ?? mesh.geometry;
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
    const canvas = createCanvas();
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('The displacement texture is not CPU-readable.');
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
  const uvScale = material.displacementUvProjectionScale;

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

const warnedDirectionGeometry = new WeakSet<Geometry>();

/** Prepare auto-generated source attributes before the renderer captures array identities. */
export function ensureMeshGeometryAttributes(meshes: readonly Mesh[]) {
  for (const { geometry, materials } of meshes) {
    if (!geometry.tangent && !warnedDirectionGeometry.has(geometry) && materials.some(m => m.anisotropyMap || m.specularAnisotropyRotation !== 0 || m.coatAnisotropyRotation !== 0 || (m.specularAnisotropyModel === 'gltf' && m.specularAnisotropy > 0))) {
      console.warn('MuTracer: anisotropy direction has no vertex tangent; deriving a frame from the selected UV set with a stable fallback for degenerate UVs.');
      warnedDirectionGeometry.add(geometry);
    }
    if (!geometry.position?.array.length) continue;
    if (!geometry.normal) computeGeometryNormals(geometry);
    if (!geometry.tangent && geometry.uv) generateVertexTangents(geometry);
  }
}

function getMeshBlasGeometry(mesh: Mesh, displacement = true) {
  const geometry = displacement ? getPreparedMeshGeometry(mesh) : mesh.geometry;
  if (!geometry.normal) computeGeometryNormals(geometry);
  if (!geometry.tangent && geometry.uv) generateVertexTangents(geometry);
  return geometry;
}

/** Geometry and displacement inputs shared by synchronous and Worker BLAS builds. */
export function getMeshBlasInput(mesh: Mesh) {
  const geometry = getMeshBlasGeometry(mesh);
  const heightMap = getMeshDisplacementMap(mesh);
  const displacementScale = heightMap ? getMeshDisplacementScale(mesh) : 0;
  const trianglesDisplacement = Math.abs(displacementScale) > 1e-6
    ? getTrianglesDisplacementRange(geometry, heightMap, getMeshDisplacementMaterial(mesh))
    : undefined;
  return { geometry, displacementScale, trianglesDisplacement };
}

/** Whether a static mesh still needs a BLAS before it can be rendered. */
export function meshNeedsStaticBvh(mesh: Mesh, config?: BvhBuildConfig) {
  return !!mesh.geometry.position?.array.length && !mesh.geometry.dynamic &&
    (!getGeometryBvh(getPreparedMeshGeometry(mesh)) || !!config && !geometryBvhConfigMatches(getPreparedMeshGeometry(mesh), config));
}

/** Capture inputs whose changes invalidate an asynchronous BLAS result. */
export function captureMeshBlasSnapshot(mesh: Mesh, target: Geometry) {
  const displacementMap = getMeshDisplacementMap(mesh);
  return {
    geometry: mesh.geometry,
    version: mesh.geometry.version,
    cacheKey: getPreparedMeshGeometryCacheKey(mesh),
    bvh: getGeometryBvh(target),
    displacementMap,
    displacementScale: getMeshDisplacementScale(mesh),
    displacementTextureKey: displacementMap
      ? getDisplacementTextureDataCacheKey(displacementMap) : undefined
  };
}

/** Check that a result still belongs to the captured mesh inputs. */
export function meshBlasSnapshotIsCurrent(
  mesh: Mesh, target: Geometry, snapshot: ReturnType<typeof captureMeshBlasSnapshot>
) {
  return mesh.geometry === snapshot.geometry && mesh.geometry.version === snapshot.version &&
    getPreparedMeshGeometryCacheKey(mesh) === snapshot.cacheKey && getGeometryBvh(target) === snapshot.bvh &&
    getMeshDisplacementMap(mesh) === snapshot.displacementMap &&
    getMeshDisplacementScale(mesh) === snapshot.displacementScale &&
    (!snapshot.displacementMap || getDisplacementTextureDataCacheKey(snapshot.displacementMap) ===
      snapshot.displacementTextureKey);
}

function prepareMeshGeometryBvh(mesh: Mesh, displacement = true) {
  const geometry = getMeshBlasGeometry(mesh, displacement);
  const displacementScale = displacement && getMeshDisplacementMap(mesh) ? getMeshDisplacementScale(mesh) : 0;
  if (geometry.dynamic && getGeometryBvh(geometry)?.builder !== 'builtin') setGeometryBvh(geometry, undefined);
  if (!getGeometryBvh(geometry)) {
    const trianglesDisplacement = displacement ? getMeshBlasInput(mesh).trianglesDisplacement : undefined;
    setGeometryBvh(geometry, buildBLAS(geometry, displacementScale, trianglesDisplacement));
  }
  return { geometry, displacementScale };
}

export function updateMeshInstances(meshes: Mesh[], options: { displacement?: boolean } = {}) {
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
    .filter((mesh) => mesh.geometry.position?.array.length > 0)
    .map((mesh) => {
      let { geometry, displacementScale } = prepareMeshGeometryBvh(mesh, options.displacement !== false);
      const bvhBounds = getBvhBounds(geometry);
      const bounds = computeBounds(geometry, mesh.transform, bvhBounds);

      let geoIdx = geometryIndexMap.get(geometry);
      const materialsIndices = mesh.materials.map((material) => {
        const key = material;
        if (!materialIndexMap.has(key)) {
          materialIndexMap.set(key, materials.length);
          materials.push(material);
        }
        return materialIndexMap.get(key)!;
      });

      // Explicit vertex indices are global after merging. Batches with a
      // different material table need their own vertex region, even when the
      // table contains just one material. Equal tables can share the region.
      if (geoIdx != null && geometry.materialIndex &&
        (materialsIndices.length !== globalMaterialIndicesMap[geoIdx].length ||
          materialsIndices.some((index, i) => index !== globalMaterialIndicesMap[geoIdx!][i]))) {
        const bvh = getGeometryBvh(geometry);
        geometry = new Geometry(geometry);
        setGeometryBvh(geometry, bvh);
        geoIdx = undefined;
      }

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
        transform: mesh.transform,
        materialsIndices: materialsIndices.map((idx) =>
          packMaterialIndexAndWeightToInt(idx, 1)
        ),
        displacementScale
      } satisfies TLASInstance;
      if (!(mesh instanceof InstancedMesh) && (
        !bounds.min.every(isFinite) ||
        !bounds.max.every(isFinite) ||
        !mesh.transform.every(isFinite)
      )) {
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
    geometryStates: new Map(instanceBindings.map(binding => {
      const source = binding.mesh.geometry;
      return [source, { topologyVersion: source.topologyVersion, indices: source.indices.array,
        indexCount: source.indices.array.length }];
    })),
    instances: meshes.some(mesh => mesh instanceof InstancedMesh) ? updateMeshInstanceTransforms(instanceBindings) : instances,
    materials,
    instanceBindings,
    emissiveBindings,
    blases: geometries.map((geo) => ({
      bvh: getGeometryBvh(geo)!,
      verticesCount: geo.vertexCount,
      trainglesCount: geo.indices.array.length / 3
    }))
  };
}

function mergeGeometry(
  geometries: Geometry[],
  globalMaterialIndicesMap: number[][],
  regions: Map<Geometry, { vertexOffset: number; indexOffset: number; materialIndices: number[] }>
) {
  const totalVertexCount = geometries.reduce(
    (sum, geo) => sum + geo.vertexCount,
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
      ? new Attribute(new Float32Array(4 * totalVertexCount), 4)
      : undefined,
    indices: indexAttrib
  });

  let currentVertex = 0;
  let currentIndex = 0;

  geometries.forEach((geometry, idx) => {
    const vertexCount = geometry.vertexCount;
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
      const source = geometry.tangent;
      for (let v = 0; v < vertexCount; v++) {
        for (let c = 0; c < 4; c++) mergedGeometry.tangent!.array[(currentVertex + v) * 4 + c] =
          c < source.itemSize ? source.array[v * source.itemSize + c] : hasGeneratedVertexTangents(geometry) ? 0 : 2;
      }
    }

    writeMaterialIndices(geometry, globalMaterialIndex, materialIndexAttrib.array, currentVertex);

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
    : geometry.vertexCount;
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

/** Batch records are regenerated together; refit all numeric source slots. */
export function dirtyMeshInstanceIndices(bindings: PreparedMeshInstanceBinding[], meshes: ReadonlySet<Mesh>, instances: MeshInstances) {
  if (instances instanceof PackedMeshInstances) return new Set(Array.from({length: instances.length}, (_, i) => i));
  return new Set(bindings.flatMap((binding, i) => meshes.has(binding.mesh) ? [i] : []));
}

/** Refreshes color storage without computing transforms or bounds. Returns packed source slots. */
export function updateMeshInstanceColors(bindings: PreparedMeshInstanceBinding[], instances: MeshInstances, meshes: ReadonlySet<Mesh>) {
  const dirty = new Set<number>();
  if (!(instances instanceof PackedMeshInstances)) return dirty;
  let sourceStart = 0, packedIndex = 0;
  for (const {mesh} of bindings) {
    const count = meshInstanceCount(mesh), sourceEnd = sourceStart + count;
    while (packedIndex < instances.length && instances.sourceIndices[packedIndex] < sourceEnd) {
      if (meshes.has(mesh)) {
        const localIndex = instances.sourceIndices[packedIndex] - sourceStart;
        const colors = mesh instanceof InstancedMesh ? mesh.colors : undefined;
        for (let k = 0; k < 3; k++) instances.colors[packedIndex * 3 + k] = colors?.[localIndex * 3 + k] ?? 1;
        dirty.add(packedIndex);
      }
      packedIndex++;
    }
    sourceStart = sourceEnd;
  }
  return dirty;
}
