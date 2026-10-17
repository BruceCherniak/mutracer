import { pixelLength, pixelValue } from '../scene/texturePixels.js';
import { materialEmission } from './materialEmission.js';
import { read, size } from '../math/access.js';
import { meshInstanceCount, meshInstanceTransform } from './meshInstances.js';
import { getRectLightArea, getSphereLightArea, getSpotLightArea, getSpotLightRadiance, getSpotLightShapingFluxFactor } from './lightsData.js';
import { localMaterialIndex } from './materialIndices.js';
import { attributeLength, attributeValue } from '../scene/attributeData.js';
import { type TexturePixelSource, vec3 } from '../math.js';
import DirectionalLight from '../scene/DirectionalLight.js';
import Geometry from '../scene/Geometry.js';
import type Mesh from '../scene/MeshState.js';
import type RectLight from '../scene/RectLightState.js';
import SphereLight from '../scene/SphereLight.js';
import SpotLight from '../scene/SpotLight.js';
import IESProfile from '../scene/IESProfile.js';
import type OpenPBRMaterial from '../scene/MaterialState.js';

export * from './lightConstants.js';
type AnalyticLight = DirectionalLight | SphereLight | SpotLight | RectLight;

export interface EmissiveTriangle {
  p0: vec3.Vec3Array;
  p1: vec3.Vec3Array;
  p2: vec3.Vec3Array;
  uv0: [number, number];
  uv1: [number, number];
  uv2: [number, number];
  secondaryUv0: [number, number];
  secondaryUv1: [number, number];
  secondaryUv2: [number, number];
  materialIndex: number;
  area: number;
  samplingLuminance: number;
  selectionPmf: number;
}

export interface EmissiveMeshBinding {
  mesh: Mesh;
  geometry: Geometry;
  materialIndices: number[];
}

export interface LightChoiceInput {
  sourceType: number;
  sourceIndex: number;
  weight: number;
}

export interface LightSamplingDistribution {
  choices: Uint32Array;
  pmfs: Float32Array;
  totalWeight: number;
}

const luminanceCoefficients = [0.2126, 0.7152, 0.0722] as const;

export function colorLuminance<T extends ArrayLike<number>>(color: T) {
  return Math.max(
    color[0] * luminanceCoefficients[0] +
      color[1] * luminanceCoefficients[1] +
      color[2] * luminanceCoefficients[2],
    0
  );
}

export function estimateAnalyticLightPower(light: AnalyticLight) {
  const emittedLuminance = colorLuminance(light.color) * light.intensity;
  if (!(emittedLuminance > 0)) return 0;
  if (light.type === 'RectLight') {
    return emittedLuminance * Math.PI * Math.max(getRectLightArea(light), 0);
  }
  if (light.type === 'SphereLight') {
    if (light.radius === 0) return emittedLuminance * 4 * Math.PI;
    return emittedLuminance * Math.PI * Math.max(getSphereLightArea(light), 0);
  }
  if (light.type === 'SpotLight') {
    const radianceLuminance =
      colorLuminance(light.color) * getSpotLightRadiance(light);
    // The selection power is an approximation and ignores the IES profile.
    if (light.radius === 0) {
      return emittedLuminance *
        4 * Math.PI *
        getSpotLightShapingFluxFactor(light);
    }
    return (
      radianceLuminance *
      Math.PI *
      getSpotLightArea(light) *
      getSpotLightShapingFluxFactor(light)
    );
  }
  // A directional light has no finite emitting area. 4π keeps its heuristic
  // weight on roughly the same scale as an environment map integral.
  return emittedLuminance * 4 * Math.PI;
}

export function sphereSolidAnglePdf(distanceToCenter: number, radius: number) {
  if (distanceToCenter <= radius) return 1 / (4 * Math.PI);
  const cosThetaMax = Math.sqrt(
    Math.max(0, 1 - radius * radius / (distanceToCenter * distanceToCenter))
  );
  return 1 / Math.max(2 * Math.PI * (1 - cosThetaMax), 1e-8);
}

/** Packs unique 128² peak-normalized IES profiles four scalar samples per texel. */
export function packIESProfiles(lights: AnalyticLight[], firstTexel = 0) {
  const offsets = new Int32Array(lights.length).fill(-1);
  const profiles: IESProfile[] = [];
  const indices = new Map<IESProfile, number>();
  lights.forEach((light, index) => {
    if (light.type !== 'SpotLight' || !light.iesProfile) return;
    let profileIndex = indices.get(light.iesProfile);
    if (profileIndex == null) {
      profileIndex = profiles.length;
      indices.set(light.iesProfile, profileIndex);
      profiles.push(light.iesProfile);
    }
    offsets[index] = firstTexel + profileIndex * ((128 * 128) / 4);
  });
  const data = new Float32Array(profiles.length * 128 * 128);
  profiles.forEach((profile, index) => data.set(profile.data, index * 128 * 128));
  return { data, offsets, texelCount: data.length / 4 };
}

// Keep the input object identity across native record-width conversions.
const environmentPowers = new WeakMap<object, number>();

export function estimateEnvironmentPower<T extends TexturePixelSource>(image?: T) {
  if (!image?.data || !image.width || !image.height) return 0;
  const cached = environmentPowers.get(image);
  if (cached !== undefined) return cached;
  const { data, width, height } = image;
  const power = environmentPower(data, width, height);
  environmentPowers.set(image, power);
  return power;
}

/** Reusable typed choices; insertion order matches the sampling distribution. */
export class LightChoiceBuffer {
  count = 0;
  sourceTypes = new Uint32Array(0);
  sourceIndices = new Uint32Array(0);
  weights = new Float64Array(0);
  reserve(capacity: number) {
    this.count = 0;
    if (this.weights.length < capacity) {
      this.sourceTypes = new Uint32Array(capacity);
      this.sourceIndices = new Uint32Array(capacity);
      this.weights = new Float64Array(capacity);
    }
  }
  push(sourceType: number, sourceIndex: number, weight: number) {
    if (!(weight > 0) || !isFinite(weight)) return;
    const i = this.count++;
    this.sourceTypes[i] = sourceType; this.sourceIndices[i] = sourceIndex; this.weights[i] = weight;
  }
}

/** Builds a Walker alias table. Each 16-byte entry is probability/alias/type/index. */
export function buildLightAliasTable(inputs: LightChoiceInput[] | LightChoiceBuffer): LightSamplingDistribution {
  let active: LightChoiceBuffer;
  if (!Array.isArray(inputs)) active = inputs;
  else {
    active = new LightChoiceBuffer(); active.reserve(inputs.length);
    for (const input of inputs) active.push(input.sourceType, input.sourceIndex, input.weight);
  }
  const count = active.count;
  let totalWeight = 0;
  for (let i = 0; i < count; i++) totalWeight += active.weights[i];
  if (!count || !(totalWeight > 0)) return { choices: new Uint32Array(4), pmfs: new Float32Array(0), totalWeight: 0 };
  const pmfs = new Float32Array(count);
  const scaled = new Float64Array(count);
  const small = new Uint32Array(count), large = new Uint32Array(count);
  let smallCount = 0, largeCount = 0;
  for (let i = 0; i < count; i++) {
    pmfs[i] = active.weights[i] / totalWeight;
    scaled[i] = pmfs[i] * count;
    if (scaled[i] < 1) small[smallCount++] = i; else large[largeCount++] = i;
  }
  const buffer = new ArrayBuffer(count * 16);
  const floats = new Float32Array(buffer), ints = new Int32Array(buffer);
  while (smallCount && largeCount) {
    const low = small[--smallCount] + 0, high = large[--largeCount] + 0;
    floats[low * 4] = scaled[low]; ints[low * 4 + 1] = high;
    scaled[high] = scaled[high] + scaled[low] - 1;
    if (scaled[high] < 1) small[smallCount++] = high; else large[largeCount++] = high;
  }
  for (let i = 0; i < smallCount; i++) { const index = small[i]; floats[index * 4] = 1; ints[index * 4 + 1] = index; }
  for (let i = 0; i < largeCount; i++) { const index = large[i]; floats[index * 4] = 1; ints[index * 4 + 1] = index; }
  for (let i = 0; i < count; i++) { ints[i * 4 + 2] = active.sourceTypes[i]; ints[i * 4 + 3] = active.sourceIndices[i]; }
  return { choices: new Uint32Array(buffer), pmfs, totalWeight };
}

function dominantLocalMaterial(geometry: Geometry, triangleOffset: number, materialCount: number) {
  // Public triangles have the same raw material index on all three corners.
  return localMaterialIndex(geometry, attributeValue(geometry.indices.array, triangleOffset), materialCount);
}

export function collectEmissiveTriangles(
  bindings: EmissiveMeshBinding[],
  materials: OpenPBRMaterial[]
) {
  const triangles: EmissiveTriangle[] = [];
  const local = [vec3.create(), vec3.create(), vec3.create()];
  const world = [vec3.create(), vec3.create(), vec3.create()];
  const edge0 = vec3.create();
  const edge1 = vec3.create();
  const cross = vec3.create();

  for (const { mesh, geometry, materialIndices } of bindings) {
    // Emission is constant during this synchronous collection. Compute it once
    // per local material table instead of allocating an RGB array per triangle.
    const samplingLuminances: number[] = [];
    for (let local = 0; local < Math.max(1, materialIndices.length); local++) {
      const material = materials[materialIndices[local] ?? materialIndices[0] ?? 0];
      samplingLuminances.push(!material || material.shadowCatcher || material.unlit
        ? 0 : colorLuminance(materialEmission(material)));
    }
    const matrix = new Array<number>(16).fill(0);
    for (let instance = 0; instance < meshInstanceCount(mesh); instance++) {
      meshInstanceTransform(mesh, instance, matrix);
      const indices = geometry.indices.array;
      const positions = geometry.position.array;
      const uvs = geometry.uv?.array;
      const secondaryUvs = geometry.uv1?.array ?? uvs;
      for (let triangleOffset = 0; triangleOffset < attributeLength(indices); triangleOffset += 3) {
        const localMaterialIndex = dominantLocalMaterial(geometry, triangleOffset, materialIndices.length);
        const materialIndex = materialIndices[localMaterialIndex] ?? materialIndices[0] ?? 0;
        const samplingLuminance = samplingLuminances[localMaterialIndex];
        if (!(samplingLuminance > 1e-8)) continue;

        const triangleIndices = [
          attributeValue(indices, triangleOffset),
          attributeValue(indices, triangleOffset + 1),
          attributeValue(indices, triangleOffset + 2)
        ];
        for (let corner = 0; corner < 3; corner++) {
          const vertex = triangleIndices[corner];
          vec3.set(
            local[corner],
            positions[vertex * geometry.position.itemSize],
            positions[vertex * geometry.position.itemSize + 1],
            positions[vertex * geometry.position.itemSize + 2]
          );
          vec3.transformMat4(world[corner], local[corner], matrix);
        }
        vec3.sub(edge0, world[1], world[0]);
        vec3.sub(edge1, world[2], world[0]);
        vec3.cross(cross, edge0, edge1);
        const area = 0.5 * vec3.length(cross);
        if (!(area > 1e-10) || !isFinite(area)) continue;

        const triangleUvs = triangleIndices.map((vertex) =>
          uvs
            ? [uvs[vertex * 2], uvs[vertex * 2 + 1]] as [number, number]
            : [0, 0] as [number, number]
        );
        const triangleSecondaryUvs = triangleIndices.map((vertex) =>
          secondaryUvs
            ? [secondaryUvs[vertex * 2], secondaryUvs[vertex * 2 + 1]] as [number, number]
            : [0, 0] as [number, number]
        );
        triangles.push({
          p0: vec3.clone(world[0]),
          p1: vec3.clone(world[1]),
          p2: vec3.clone(world[2]),
          uv0: triangleUvs[0],
          uv1: triangleUvs[1],
          uv2: triangleUvs[2],
          secondaryUv0: triangleSecondaryUvs[0],
          secondaryUv1: triangleSecondaryUvs[1],
          secondaryUv2: triangleSecondaryUvs[2],
          materialIndex,
          area,
          samplingLuminance,
          selectionPmf: 0
        });
      }
    }
  }
  return triangles;
}

export function packEmissiveTriangles(triangles: EmissiveTriangle[], data: Float32Array = new Float32Array(Math.max(triangles.length, 1) * 24)) {
  triangles.forEach((triangle, index) => {
    const offset = index * 24;
    data.set(triangle.p0, offset);
    data[offset + 3] = triangle.selectionPmf;
    data.set(triangle.p1, offset + 4);
    data[offset + 7] = triangle.area;
    data.set(triangle.p2, offset + 8);
    data[offset + 11] = triangle.materialIndex;
    data.set(triangle.uv0, offset + 12);
    data.set(triangle.uv1, offset + 14);
    data.set(triangle.uv2, offset + 16);
    data.set(triangle.secondaryUv0, offset + 18);
    data.set(triangle.secondaryUv1, offset + 20);
    data.set(triangle.secondaryUv2, offset + 22);
  });
  return data;
}


interface EmissiveCacheEntry { geometry: Geometry; version: number; instanceVersion: number; instanceCount: number; instanceTransforms?: Float32Array; matrix: Float64Array;
    indices: number[]; activity: boolean[]; triangles: EmissiveTriangle[] }

// WeakMap class fields have no native representation in scriptc 0.3.2.
// Keep the same per-cache weak ownership in a module-owned registry.
const emissiveBindings = new WeakMap<EmissiveTriangleCache, WeakMap<Mesh, EmissiveCacheEntry>>();

/** Caches world-space vertices per mesh, independently of emission strength. */
export class EmissiveTriangleCache {
  constructor() { emissiveBindings.set(this, new WeakMap()); }
  private _triangles: EmissiveTriangle[] = [];
  collect(bindings: EmissiveMeshBinding[], materials: OpenPBRMaterial[]) {
    const cachedBindings = emissiveBindings.get(this)!;
    this._triangles.length = 0;
    for (const binding of bindings) {
      const { mesh, geometry, materialIndices } = binding;
      const isActive = (index: number) => {
        const m = materials[index];
        return !!m && !m.unlit && !m.shadowCatcher && colorLuminance(materialEmission(m)) > 1e-8;
      };
      const instanceVersion = mesh.instanceData?.transformsVersion ?? 0;
      const instanceCount = meshInstanceCount(mesh);
      const instanceTransforms = mesh.instanceData?.transforms;
      let cached = cachedBindings.get(mesh);
      if (!cached || cached.geometry !== geometry || cached.version !== geometry.version || cached.instanceVersion !== instanceVersion || cached.instanceCount !== instanceCount || cached.instanceTransforms !== instanceTransforms ||
        cached.indices.length !== materialIndices.length || materialIndices.some((index, i) =>
          cached!.indices[i] !== index || cached!.activity[i] !== isActive(index)) ||
        meshMatrixChanged(mesh, cached.matrix)) {
        cached = { geometry, version: geometry.version, instanceVersion, instanceCount, instanceTransforms, matrix: copyMeshMatrix(mesh),
          indices: materialIndices.slice(), activity: materialIndices.map(isActive),
          triangles: collectEmissiveTriangles([binding], materials) };
        cachedBindings.set(mesh, cached);
      } else {
        for (const triangle of cached.triangles) {
          const m = materials[triangle.materialIndex];
          triangle.samplingLuminance = colorLuminance(materialEmission(m));
        }
      }
      for (const triangle of cached.triangles) this._triangles.push(triangle);
    }
    return this._triangles;
  }
}

function copyMeshMatrix(mesh: Mesh): Float64Array {
  const out = new Float64Array(meshMatrixLength(mesh));
  for (let i = 0; i < out.length; i++) out[i] = read(mesh.transform, i);
  return out;
}
function meshMatrixLength(mesh: Mesh): number {
  return size(mesh.transform);
}
function meshMatrixChanged(mesh: Mesh, previous: Float64Array): boolean {
  for (let i = 0; i < meshMatrixLength(mesh); i++) if (!Object.is(read(mesh.transform, i), previous[i])) return true;
  return false;
}

function environmentPower(data: NonNullable<TexturePixelSource['data']>, width: number, height: number): number {
  const channels = Math.max(Math.floor(pixelLength(data) / (width * height)), 1);
  const scale = (data instanceof Uint8Array || data instanceof Uint8ClampedArray) ? 1 / 255 : 1;
  let weightedLuminance = 0;
  for (let y = 0; y < height; y++) {
    const sinTheta = Math.sin(Math.PI * (y + 0.5) / height);
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      weightedLuminance +=
        colorLuminance([
          pixelValue(data, offset) * scale,
          pixelValue(data, offset + Math.min(1, channels - 1)) * scale,
          pixelValue(data, offset + Math.min(2, channels - 1)) * scale
        ]) * sinTheta;
    }
  }
  return weightedLuminance * (2 * Math.PI * Math.PI) / (width * height);
}
