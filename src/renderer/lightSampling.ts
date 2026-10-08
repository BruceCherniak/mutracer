import { TexturePixelSource, vec3 } from '../math';
import DirectionalLight from '../scene/DirectionalLight';
import Geometry from '../scene/Geometry';
import Mesh from '../scene/Mesh';
import RectLight from '../scene/RectLight';
import SphereLight from '../scene/SphereLight';
import SpotLight from '../scene/SpotLight';
import IESProfile from '../scene/IESProfile';
import OpenPBRMaterial from '../scene/OpenPBRMaterial';

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

export function estimateEnvironmentPower(image?: TexturePixelSource) {
  if (!image?.data || !image.width || !image.height) return 0;
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
  return weightedLuminance * (2 * Math.PI * Math.PI) / (width * height);
}

/** Builds a Walker alias table. Each 16-byte entry is probability/alias/type/index. */
export function buildLightAliasTable(
  inputs: LightChoiceInput[]
): LightSamplingDistribution {
  const active = inputs.filter((input) => input.weight > 0 && isFinite(input.weight));
  const totalWeight = active.reduce((sum, input) => sum + input.weight, 0);
  const count = active.length;
  if (!count || !(totalWeight > 0)) {
    return {
      choices: new Uint32Array(4),
      pmfs: new Float32Array(0),
      totalWeight: 0
    };
  }

  const pmfs = Float32Array.from(active, (input) => input.weight / totalWeight);
  const scaled = Array.from(pmfs, (pmf) => pmf * count);
  const probabilities = new Float32Array(count);
  const aliases = new Int32Array(count);
  const small: number[] = [];
  const large: number[] = [];
  scaled.forEach((value, index) => (value < 1 ? small : large).push(index));

  while (small.length && large.length) {
    const low = small.pop()!;
    const high = large.pop()!;
    probabilities[low] = scaled[low];
    aliases[low] = high;
    scaled[high] = scaled[high] + scaled[low] - 1;
    (scaled[high] < 1 ? small : large).push(high);
  }
  for (const index of [...small, ...large]) {
    probabilities[index] = 1;
    aliases[index] = index;
  }

  const buffer = new ArrayBuffer(count * 16);
  const floatView = new Float32Array(buffer);
  const intView = new Int32Array(buffer);
  active.forEach((input, index) => {
    const offset = index * 4;
    floatView[offset] = probabilities[index];
    intView[offset + 1] = aliases[index];
    intView[offset + 2] = input.sourceType;
    intView[offset + 3] = input.sourceIndex;
  });
  return { choices: new Uint32Array(buffer), pmfs, totalWeight };
}

function dominantLocalMaterial(geometry: Geometry, triangleOffset: number) {
  const attribute = geometry.materialIndex;
  if (!attribute) return 0;
  const indices = geometry.indices.array;
  const weights = new Map<number, number>();
  for (let corner = 0; corner < 3; corner++) {
    const vertex = indices[triangleOffset + corner];
    for (let slot = 0; slot < 4; slot++) {
      const packed = attribute.array[vertex * 4 + slot];
      if (packed <= 0) continue;
      const [materialIndex, weight] =
        Geometry.unpackMaterialIndexAndWeightFromInt(packed);
      weights.set(materialIndex, (weights.get(materialIndex) ?? 0) + weight);
    }
  }
  let selected = 0;
  let selectedWeight = -1;
  weights.forEach((weight, materialIndex) => {
    if (weight > selectedWeight) {
      selected = materialIndex;
      selectedWeight = weight;
    }
  });
  return selected;
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
      const localMaterialIndex = dominantLocalMaterial(geometry, triangleOffset);
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

export function packEmissiveTriangles(triangles: EmissiveTriangle[]) {
  const data = new Float32Array(Math.max(triangles.length, 1) * 24);
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
