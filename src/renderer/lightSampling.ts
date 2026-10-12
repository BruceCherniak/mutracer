import { localMaterialIndex } from './materialIndices.js';
import { TexturePixelSource, vec3 } from '../math.js';
import DirectionalLight from '../scene/DirectionalLight.js';
import Geometry from '../scene/Geometry.js';
import Mesh from '../scene/Mesh.js';
import RectLight from '../scene/RectLight.js';
import SphereLight from '../scene/SphereLight.js';
import SpotLight from '../scene/SpotLight.js';
import IESProfile from '../scene/IESProfile.js';
import OpenPBRMaterial from '../scene/OpenPBRMaterial.js';

export const LIGHT_CHOICE_ENVIRONMENT = 1;
export const LIGHT_CHOICE_ANALYTIC = 2;
export const LIGHT_CHOICE_EMISSIVE_TRIANGLE = 3;

export const LIGHT_DOMAIN_ENVIRONMENT = 0;
export const LIGHT_DOMAIN_INFINITE = 1;
export const LIGHT_DOMAIN_LOCAL_AND_EMISSIVE = 2;
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

export function colorLuminance(color: ArrayLike<number>) {
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
    return emittedLuminance * Math.PI * Math.max(RectLight.getArea(light), 0);
  }
  if (light.type === 'SphereLight') {
    if (light.radius === 0) return emittedLuminance * 4 * Math.PI;
    return emittedLuminance * Math.PI * Math.max(SphereLight.getArea(light), 0);
  }
  if (light.type === 'SpotLight') {
    const radianceLuminance =
      colorLuminance(light.color) * SpotLight.getRadiance(light);
    // The selection power is an approximation and ignores the IES profile.
    if (light.radius === 0) {
      return emittedLuminance *
        4 * Math.PI *
        SpotLight.getShapingFluxFactor(light);
    }
    return (
      radianceLuminance *
      Math.PI *
      SpotLight.getArea(light) *
      SpotLight.getShapingFluxFactor(light)
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

const environmentPowers = new WeakMap<TexturePixelSource, number>();

export function estimateEnvironmentPower(image?: TexturePixelSource) {
  if (!image?.data || !image.width || !image.height) return 0;
  const cached = environmentPowers.get(image);
  if (cached !== undefined) return cached;
  const { data, width, height } = image;
  const channels = Math.max(Math.floor(data.length / (width * height)), 1);
  let weightedLuminance = 0;
  for (let y = 0; y < height; y++) {
    const sinTheta = Math.sin(Math.PI * (y + 0.5) / height);
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const scale = data instanceof Uint8Array ? 1 / 255 : 1;
      weightedLuminance +=
        colorLuminance([
          data[offset] * scale,
          data[offset + Math.min(1, channels - 1)] * scale,
          data[offset + Math.min(2, channels - 1)] * scale
        ]) * sinTheta;
    }
  }
  const power = weightedLuminance * (2 * Math.PI * Math.PI) / (width * height);
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
  if (inputs instanceof LightChoiceBuffer) active = inputs;
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
    const low = small[--smallCount], high = large[--largeCount];
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
  return localMaterialIndex(geometry, geometry.indices.array[triangleOffset], materialCount);
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
    const indices = geometry.indices.array;
    const positions = geometry.position.array;
    const uvs = geometry.uv?.array;
    const secondaryUvs = geometry.uv1?.array ?? uvs;
    for (let triangleOffset = 0; triangleOffset < indices.length; triangleOffset += 3) {
      const localMaterialIndex = dominantLocalMaterial(geometry, triangleOffset, materialIndices.length);
      const materialIndex = materialIndices[localMaterialIndex] ?? materialIndices[0] ?? 0;
      const material = materials[materialIndex];
      if (!material || material.shadowCatcher || material.unlit) continue;
      const samplingLuminance =
        colorLuminance(material.emissionColor) * material.emissionLuminance;
      if (!(samplingLuminance > 1e-8)) continue;

      const triangleIndices = [
        indices[triangleOffset],
        indices[triangleOffset + 1],
        indices[triangleOffset + 2]
      ];
      for (let corner = 0; corner < 3; corner++) {
        const vertex = triangleIndices[corner];
        vec3.set(
          local[corner],
          positions[vertex * geometry.position.itemSize],
          positions[vertex * geometry.position.itemSize + 1],
          positions[vertex * geometry.position.itemSize + 2]
        );
        vec3.transformMat4(world[corner], local[corner], mesh.matrixWorld);
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


/** Caches world-space vertices per mesh, independently of emission strength. */
export class EmissiveTriangleCache {
  private _bindings = new WeakMap<Mesh, { geometry: Geometry; version: number; matrix: Float64Array;
    indices: number[]; activity: boolean[]; triangles: EmissiveTriangle[] }>();
  private _triangles: EmissiveTriangle[] = [];
  collect(bindings: EmissiveMeshBinding[], materials: OpenPBRMaterial[]) {
    this._triangles.length = 0;
    for (const binding of bindings) {
      const { mesh, geometry, materialIndices } = binding;
      const isActive = (index: number) => {
        const m = materials[index];
        return !!m && !m.unlit && !m.shadowCatcher && colorLuminance(m.emissionColor) * m.emissionLuminance > 1e-8;
      };
      let cached = this._bindings.get(mesh);
      if (!cached || cached.geometry !== geometry || cached.version !== geometry.version ||
        cached.indices.length !== materialIndices.length || materialIndices.some((index, i) =>
          cached!.indices[i] !== index || cached!.activity[i] !== isActive(index)) ||
        mesh.matrixWorld.some((value: number, i: number) => !Object.is(value, cached!.matrix[i]))) {
        cached = { geometry, version: geometry.version, matrix: Float64Array.from(mesh.matrixWorld),
          indices: materialIndices.slice(), activity: materialIndices.map(isActive),
          triangles: collectEmissiveTriangles([binding], materials) };
        this._bindings.set(mesh, cached);
      } else {
        for (const triangle of cached.triangles) {
          const m = materials[triangle.materialIndex];
          triangle.samplingLuminance = colorLuminance(m.emissionColor) * m.emissionLuminance;
        }
      }
      for (const triangle of cached.triangles) this._triangles.push(triangle);
    }
    return this._triangles;
  }
}
