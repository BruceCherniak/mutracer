/// <reference lib="esnext" />
/// <reference path="./browser-types.d.ts" />
import IESProfile, {parseIESProfile} from '../src/scene/IESProfile.js';
import {computeDisplacementMinmax, computeTrianglesDisplacementRange} from '../src/renderer/displacementPreparation.js';
import { applyNativeMaterialProperties } from './material-properties.js';
import { envMapDistribution } from '../src/renderer/envMapDistribution.js';
import Geometry, { Attribute } from '../src/scene/Geometry.js';
import MeshState from '../src/scene/MeshState.js';
import MaterialState from '../src/scene/MaterialState.js';
import PixelTexture from '../src/scene/PixelTexture.js';
import type TextureState from '../src/scene/TextureState.js';
import { sceneCameraParameters } from './camera-core.js';
import { InstanceState, RectLightState, SphereLight, DirectionalLight, SpotLight,
  EmissiveTriangleCache, LightChoiceBuffer, buildLightAliasTable, estimateAnalyticLightPower, estimateEnvironmentPower,
  packEmissiveTriangles, packIESProfiles, LIGHT_CHOICE_ENVIRONMENT, LIGHT_CHOICE_ANALYTIC,
  LIGHT_CHOICE_EMISSIVE_TRIANGLE } from '../src/renderer/lightCore.js';
export * from '../src/renderer/lightCore.js';
import type { AnalyticLightState } from '../src/scene/lightState.js';
import { write } from '../src/math/access.js';
import { meshInstancesLength } from '../src/renderer/packedMeshInstances.js';
import { prepareSceneMeshes, computeGeometryNormals } from '../src/renderer/scenePreparation.js';
import { buildBLAS, buildTLAS, concatBLASBuffers, getTraversalStackSizes } from '../src/renderer/bvhAccel.js';
import { getGeometryBvh, setGeometryBvh } from '../src/renderer/geometryBvh.js';
import { generateVertexTangents } from '../src/util/geometry.js';
import { packVertexAttributes } from '../src/renderer/geometryUpdates.js';
import MaterialData from '../src/renderer/MaterialData.js';
import { writeRawAtlasPlacement } from '../src/renderer/textureAtlasPixels.js';
import { wgpuMaterialConstants } from '../src/renderer/wgpuMaterialConstants.js';
import { wgpuSceneFeatureFlags } from '../src/renderer/WGPUSceneFeatures.js';
import { wgpuShaderSource } from '../src/renderer/wgpuShaderSource.js';
import { makeRayTraceUniform, packWgpuAnalyticLights, WGPU_SCENE_BUFFER_MIN_BYTES } from '../src/renderer/wgpuSceneUniform.js';
import { zSobolLog2SPP } from '../src/renderer/sampling.js';
import { getOpenPbrEnergyLutData, OPENPBR_ENERGY_LUT_WIDTH, OPENPBR_ENERGY_LUT_HEIGHT } from '../src/renderer/openPbrEnergyLut.js';

// Versioned experimental wire protocol. The Rust boundary validates every span,
// reference, numeric range and resource budget before entering this trusted core.
// All offsets/counts below are uint32 words; float payloads are IEEE f32.
export function sceneParameters(bytes: Uint8Array): Uint8Array {
  try { return buildSceneParameters(bytes); }
  catch { return new Uint8Array(new Uint32Array([2, 0, 0, 0]).buffer); }
}
function buildSceneParameters(bytes: Uint8Array): Uint8Array {
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const width = u[2], height = u[3];
  const textures: PixelTexture[] = [];
  const textureIds = new Map<TextureState, number>();
  for (let i = 0; i < u[8]; i++) {
    const off = u[13] + i * 12;
    const data = u[off + 2] === 0
      ? new Uint8Array(bytes.buffer, bytes.byteOffset + u[off + 3] * 4, u[off] * u[off + 1] * 4).slice()
      : new Float32Array(f.slice(u[off + 3], u[off + 3] + u[off] * u[off + 1] * 4));
    const texture = new PixelTexture({width: u[off], height: u[off + 1], data});
    texture.flipY = !!u[off + 4]; texture.uvChannel = u[off + 5] === 1 ? 1 : 0;
    texture.uvScale = [f[off + 6], f[off + 7]]; texture.uvOffset = [f[off + 8], f[off + 9]];
    textures.push(texture); textureIds.set(texture, i);
  }
  const environment = nativeFloatImage(u[0] >= 2 && u[20] ? textures[u[20] - 1] : undefined);
  const background = nativeFloatImage(u[0] >= 2 && u[21] ? textures[u[21] - 1] : undefined);
  const qualityFlags = u[0] >= 2 ? u[22] : 0;
  const environmentDistribution = environment ? envMapDistribution(environment) : undefined;
  const materials: MaterialState[] = [];
  for (let i = 0; i < u[6]; i++) {
    const off = u[11] + i * 24;
    const m = new MaterialState({baseColor: [f[off], f[off + 1], f[off + 2]],
      specularRoughness: f[off + 3], baseMetalness: f[off + 4], transmissionWeight: f[off + 5],
      specularIor: f[off + 6], emissionColor: [f[off + 7], f[off + 8], f[off + 9]],
      emissionLuminance: f[off + 10], coatWeight: f[off + 11], coatRoughness: f[off + 12],
      geometryOpacity: f[off + 13], geometryThinWalled: !!u[off + 14]});
    m.map = u[off + 15] === 0xffffffff ? undefined : textures[u[off + 15]];
    m.normalMap = u[off + 16] === 0xffffffff ? undefined : textures[u[off + 16]];
    m.metallicRoughnessMap = u[off + 17] === 0xffffffff ? undefined : textures[u[off + 17]];
    m.emissiveMap = u[off + 18] === 0xffffffff ? undefined : textures[u[off + 18]];
    if (u[0] >= 2) applyNativeMaterialProperties(m, textures, u, f, u[off + 20], u[off + 19]);
    materials.push(m);
  }
  const geometries: Geometry[] = [];
  for (let i = 0; i < u[4]; i++) {
    const off = u[9] + i * 12, count = u[off], indexCount = u[off + 1];
    const geometry = new Geometry({position: new Attribute(f.slice(u[off + 2], u[off + 2] + count * 3), 3),
      indices: new Attribute(u.slice(u[off + 3], u[off + 3] + indexCount), 1)});
    if (u[off + 4]) geometry.normal = new Attribute(f.slice(u[off + 4], u[off + 4] + count * 3), 3);
    if (u[off + 5]) geometry.uv = new Attribute(f.slice(u[off + 5], u[off + 5] + count * 2), 2);
    if (u[off + 6]) geometry.uv1 = new Attribute(f.slice(u[off + 6], u[off + 6] + count * 2), 2);
    if (u[0] >= 2) {
      if (u[off + 7]) geometry.color = new Attribute(f.slice(u[off + 7], u[off + 7] + count * 3), 3);
      if (u[off + 8]) geometry.tangent = new Attribute(f.slice(u[off + 8], u[off + 8] + count * 4), 4);
      if (u[off + 9]) geometry.materialIndex = new Attribute(new Int32Array(u.slice(u[off + 9], u[off + 9] + count)), 1);
    }
    if (!geometry.normal) computeGeometryNormals(geometry);
    if (!geometry.tangent && geometry.uv) generateVertexTangents(geometry);
    geometries.push(geometry);
  }
  const meshes: MeshState[] = [];
  for (let i = 0; i < u[5]; i++) {
    const off = u[10] + i * 20;
    const meshMaterials: MaterialState[] = [];
    if (u[0] >= 2 && u[off + 3]) {
      for (let k = 0; k < u[off + 3]; k++) meshMaterials.push(materials[u[u[off + 2] + k]]);
    } else meshMaterials.push(materials[u[off + 1]]);
    const mesh = new MeshState(geometries[u[off]], meshMaterials);
    if (u[0] >= 2 && u[23]) {
      const io = u[23] + i * 4, instanceCount = u[io];
      // Count UINT32_MAX denotes an ordinary mesh; zero is an empty batch.
      if (instanceCount !== 0xffffffff) mesh.setInstanceState(new InstanceState({count: instanceCount,
        transforms: f.slice(u[io + 1], u[io + 1] + instanceCount * 16),
        colors: u[io + 2] ? f.slice(u[io + 2], u[io + 2] + instanceCount * 3) : undefined}));
    }
    for (let k = 0; k < 16; k++) write(mesh.transform, k, f[off + 4 + k]);
    meshes.push(mesh);
  }
  const lights: AnalyticLightState[] = [];
  const iesProfiles = new Map<string, IESProfile>();
  for (let i = 0; i < u[7]; i++) {
    const off = u[12] + i * 28;
    let light: AnalyticLightState;
    if (u[off] === 0) light = new RectLightState({size: [f[off + 5], f[off + 6]], spread: f[off + 7],
      texture: u[0] === 3 && u[off + 8] ? textures[u[off + 8] - 1] : undefined});
    else if (u[off] === 1) light = new SphereLight({radius: f[off + 5]});
    else if (u[off] === 2) light = new DirectionalLight();
    else light = new SpotLight({radius: f[off + 5], innerAngle: f[off + 6], outerAngle: f[off + 7]});
    if (u[0] === 3 && light.type === 'SpotLight' && u[off + 10]) {
      const key = `${u[off + 9]}:${u[off + 10]}`;
      let profile = iesProfiles.get(key);
      if (!profile) {
        profile = parseIESProfile(new TextDecoder().decode(bytes.subarray(u[off + 9] * 4, u[off + 9] * 4 + u[off + 10])), 'native scene');
        iesProfiles.set(key, profile);
      }
      light.iesProfile = profile;
    }
    light.color = [f[off + 1], f[off + 2], f[off + 3]]; light.intensity = f[off + 4];
    for (let k = 0; k < 16; k++) write(light.transform, k, f[off + 12 + k]);
    lights.push(light);
  }
  const minmaxCache = new Map<PixelTexture, Uint8Array[]>();
  const projectedGeometry = new Map<Geometry, Map<string, Geometry>>();
  const prepared = prepareSceneMeshes(meshes, mesh => {
    const material = mesh.materials[0];
    const texture = material.displacementMap;
    const displacementScale = texture ? material.displacementScale : 0;
    let geometry = mesh.geometry;
    if (texture && material.displacementUvProjection !== 'none' && Math.abs(displacementScale) > 1e-6) {
      // Match browser projective-geometry sharing by source, texture and projection values.
      const key = [textureIds.get(texture), Number(texture.flipY), texture.uvScale.join(','), texture.uvOffset.join(','),
        displacementScale, material.displacementUvProjectionScale, material.displacementUvProjection].join('|');
      let entries = projectedGeometry.get(geometry);
      if (!entries) { entries = new Map<string, Geometry>(); projectedGeometry.set(geometry, entries); }
      let copy = entries.get(key);
      if (!copy) { copy = new Geometry(geometry); entries.set(key, copy); }
      geometry = copy;
    }
    if (!getGeometryBvh(geometry)) {
      let ranges: Float32Array | undefined;
      if (texture && Math.abs(displacementScale) > 1e-6) {
        if (!(texture instanceof PixelTexture)) throw new Error('Native displacement requires raw pixels.');
        let minmax = minmaxCache.get(texture);
        if (!minmax) {
          const pixels = texture.pixels.data;
          const channels = 4;
          minmax = pixels instanceof Float32Array
            ? computeDisplacementMinmax(texture.pixels.width, channels, i => Math.round(Math.min(Math.max(pixels[i], 0), 1) * 255))
            : pixels instanceof Uint8Array ? computeDisplacementMinmax(texture.pixels.width, channels, i => pixels[i])
            : pixels instanceof Uint8ClampedArray ? computeDisplacementMinmax(texture.pixels.width, channels, i => pixels[i])
            : computeDisplacementMinmax(texture.pixels.width, channels, i => Math.round(Math.min(Math.max(pixels[i], 0), 1) * 255));
          minmaxCache.set(texture, minmax);
        }
        ranges = computeTrianglesDisplacementRange(geometry, minmax, texture.pixels.width, texture.flipY, material);
      }
      setGeometryBvh(geometry, buildBLAS(geometry, displacementScale, ranges));
    }
    return {geometry, displacementScale};
  });
  const blases = prepared.blases, tlas = buildTLAS(prepared.instances, blases);
  const blas = new Uint8Array(concatBLASBuffers(blases));
  const bvh = new Uint8Array(tlas.buffer.byteLength + blas.byteLength);
  bvh.set(new Uint8Array(tlas.buffer)); bvh.set(blas, tlas.buffer.byteLength);
  const table = new MaterialData(prepared.materials, lights.map(light => light.type === 'RectLight' ? light.texture : undefined), texture => {
    if (!(texture instanceof PixelTexture)) throw new Error('Native scene requires raw pixels.');
    return Number(texture.pixels.data instanceof Float32Array);
  }, {maxTextureDimension2D: 4096, maxTextureArrayLayers: 256, maxTextureArrayBytes: 64 * 1024 * 1024});
  const geometry = prepared.geometry;
  const names = ['position', 'normal', 'uv', 'uv1', 'color', 'tangent', 'materialIndex'] as const;
  const offsets: number[] = [];
  let stride = 0;
  for (const name of names) { offsets.push(stride); if (geometry[name]) stride += 4; }
  const attributes = new Float32Array(geometry.vertexCount * stride);
  packVertexAttributes(geometry, attributes, stride, offsets, 0, geometry.vertexCount);
  const stacks = getTraversalStackSizes(tlas, blases);
  const constants: Record<string, boolean | number> = {USE_BACKGROUND: !(qualityFlags & 4), USE_BACKGROUND_MAP: !!background,
    USE_ENVMAP: !!environment, USE_GROUNDED_BACKGROUND: false, SAMPLING_PATTERN: 0, BEVEL_SAMPLES: 8,
    TLAS_STACK_SIZE: Math.max(8, 2 ** Math.ceil(Math.log2(Math.max(1, stacks.tlas)))),
    BLAS_STACK_SIZE: Math.max(32, 2 ** Math.ceil(Math.log2(Math.max(1, stacks.blas)))),
    USE_UV: geometry.uv != null, USE_VERTEX_COLOR: geometry.color != null, ATTR_STRIDE: stride / 4,
    ...wgpuMaterialConstants(prepared.materials, table, geometry, 8)};
  const offsetNames: string[] = ['POSITION_OFF', 'NORMAL_OFF', 'UV_OFF', 'UV1_OFF', 'COLOR_OFF', 'TANGENT_OFF', 'MATERIALINDEX_OFF'];
  for (let i = 0; i < offsetNames.length; i++) constants[offsetNames[i]] = offsets[i] / 4;
  const shader = new TextEncoder().encode(wgpuShaderSource(constants, {hasDisplacement: table.displacementMaps.length > 0,
    hasAlpha: false, hasSceneAlpha: Boolean(constants.HAS_ALPHA),
    hasAnisotropyDirections: Boolean(constants.USE_ANISOTROPY_DIRECTIONS),
    hasCoatNormals: Boolean(constants.USE_COAT_NORMAL_FRAMES), blasLayoutMask: 1}, true));
  const mapCount = Number(constants.NUM_MAPS), mapInfo = new Float32Array(mapCount * 12);
  mapInfo.set(table.bufferData.mapInfo); mapInfo.set(table.bufferData.mapTransform, mapCount * 4);
  for (let i = 0; i < table.bufferData.mapUvChannel.length; i++) {
    mapInfo[mapCount * 8 + i * 4] = table.bufferData.mapUvChannel[i];
    mapInfo[mapCount * 8 + i * 4 + 1] = table.bufferData.mapColorLinear[i];
  }
  const atlas = table.atlas, atlasLayers = Math.max(2, atlas.pages.length);
  const atlasBytes = new Uint8Array(atlas.width * atlas.height * atlasLayers * atlas.bytesPerPixel);
  for (let layer = 0; layer < atlas.pages.length; layer++) {
    const data = atlas.floatStorage ? new Uint16Array(atlas.width * atlas.height * 4) : new Uint8Array(atlas.width * atlas.height * 4);
    for (const placement of atlas.pages[layer].placements) {
      const texture = table.textures[placement.index];
      if (!(texture instanceof PixelTexture)) throw new Error('Native scene requires raw pixels.');
      writeRawAtlasPlacement(data, atlas.width, placement, {image: texture.pixels, flipY: texture.flipY}, atlas.floatStorage);
    }
    atlasBytes.set(new Uint8Array(data instanceof Uint16Array ? data.buffer : data.buffer), layer * atlas.width * atlas.height * atlas.bytesPerPixel);
  }
  const emissive = new EmissiveTriangleCache().collect(prepared.emissiveBindings, prepared.materials);
  const choices = new LightChoiceBuffer(); choices.reserve(1 + lights.length + emissive.length);
  choices.push(LIGHT_CHOICE_ENVIRONMENT, 0, estimateEnvironmentPower(environment));
  for (let i = 0; i < lights.length; i++) choices.push(LIGHT_CHOICE_ANALYTIC, i, estimateAnalyticLightPower(lights[i]));
  for (let i = 0; i < emissive.length; i++) choices.push(LIGHT_CHOICE_EMISSIVE_TRIANGLE, i, emissive[i].area * emissive[i].samplingLuminance);
  const distribution = buildLightAliasTable(choices), lightPmfs = new Array<number>(lights.length).fill(0);
  let environmentPmf = 0;
  for (let i = 0; i < choices.count; i++) {
    if (choices.sourceTypes[i] === LIGHT_CHOICE_ENVIRONMENT) environmentPmf = distribution.pmfs[i];
    if (choices.sourceTypes[i] === LIGHT_CHOICE_ANALYTIC) lightPmfs[choices.sourceIndices[i]] = distribution.pmfs[i];
    else if (choices.sourceTypes[i] === LIGHT_CHOICE_EMISSIVE_TRIANGLE) emissive[choices.sourceIndices[i]].selectionPmf = distribution.pmfs[i];
  }
  const emissiveTexels = emissive.length * 6, profileStart = emissiveTexels + Math.max(choices.count, 1);
  const profiles = packIESProfiles(lights, profileStart);
  const lightWidth = Math.max(16, Math.ceil(Math.sqrt(Math.max(profileStart + profiles.texelCount, 1)) / 16) * 16);
  const lightHeight = Math.ceil(Math.max(profileStart + profiles.texelCount, 1) / lightWidth);
  const lightData = new Float32Array(lightWidth * lightHeight * 4);
  if (emissive.length) packEmissiveTriangles(emissive, lightData);
  new Uint32Array(lightData.buffer).set(distribution.choices, emissiveTexels * 4);
  lightData.set(profiles.data, profileStart * 4);
  const lightUniform = new Float32Array(64 * 24);
  lightUniform.set(packWgpuAnalyticLights(lights, table.lightTexturesIndices, lightPmfs, i => profiles.offsets[i]));
  const rt = makeRayTraceUniform();
  rt.views.outputSize.set([width, height]); rt.views.scaleOffset.set([1, 1, 0, 0]);
  rt.views.lightsCount[0] = lights.length; rt.views.transmissiveOutputAlphaMin[0] = 1;
  rt.views.jitter.set([.5, .5]);
  if (!background && !(qualityFlags & 4)) rt.views.backgroundColor.set(f.slice(16, 20));
  rt.views.backgroundFlags[0] = (qualityFlags & 4 ? 0 : 1) | (background ? 2 : 0); rt.views.blasOffset[0] = tlas.buffer.byteLength / 16;
  rt.views.isEmpty[0] = Number(meshInstancesLength(prepared.instances) === 0); rt.views.bevel[0] = Number(!!(qualityFlags & 1));
  rt.views.dispersionWavelengths[0] = qualityFlags & 2 ? 3 : 1; rt.views.lightChoiceCount[0] = choices.count;
  rt.views.envLightPmf[0] = environmentPmf; rt.views.lightWeightTotal[0] = distribution.totalWeight;
  rt.views.lightSamplingTextureWidth[0] = lightWidth; rt.views.lightChoiceTexelOffset[0] = emissiveTexels;
  rt.views.sequenceSeed[0] = 12345; rt.views.zSobolLogSPP[0] = zSobolLog2SPP(64);
  rt.views.bounces[0] = 6; rt.views.directLightCandidates[0] = 2;
  rt.views.sceneFeatureFlags[0] = wgpuSceneFeatureFlags(constants);
  const cameraUniform = sceneCameraParameters(bytes.subarray(u[14] * 4, u[14] * 4 + 128), width, height);
  // Output packet: version, count, width, height, then 8-word resource descriptors
  // (id, kind[0=buffer,1=texture,2=WGSL], length, width,height,layers,format,offset).
  const parts: Uint8Array[] = [], records: number[][] = [];
  function add(id: number, kind: number, data: Uint8Array, w: number, h: number, layers: number, format: number) {
    if (kind === 0 && id <= 3 && data.length < WGPU_SCENE_BUFFER_MIN_BYTES) {
      const padded = new Uint8Array(WGPU_SCENE_BUFFER_MIN_BYTES); padded.set(data); data = padded;
    }
    records.push([id, kind, data.length, w, h, layers, format, 0]); parts.push(data);
  }
  add(1, 0, bvh, 0, 0, 0, 0); add(2, 0, new Uint8Array(tlas.instancesBuffer!), 0, 0, 0, 0);
  add(3, 0, new Uint8Array(attributes.buffer), 0, 0, 0, 0); add(4, 0, new Uint8Array(table.getBufferArray().buffer), 0, 0, 0, 0);
  add(5, 0, new Uint8Array(mapInfo.buffer), 0, 0, 0, 0); add(6, 0, cameraUniform, 0, 0, 0, 0);
  add(7, 0, new Uint8Array(rt.buffer), 0, 0, 0, 0); add(8, 0, new Uint8Array(lightUniform.buffer), 0, 0, 0, 0);
  add(20, 1, atlasBytes, atlas.width, atlas.height, atlasLayers, atlas.floatStorage ? 1 : 0);
  add(21, 1, environment ? new Uint8Array(environment.data.buffer) : new Uint8Array(16), environment?.width ?? 1, environment?.height ?? 1, 1, 2);
  if (environmentDistribution) {
    const data = environmentDistribution.data;
    if (!(data instanceof Float32Array)) throw new Error('Expected float environment distribution.');
    add(22, 1, new Uint8Array(data.buffer), environmentDistribution.width, environmentDistribution.height, 1, 4);
  } else add(22, 1, new Uint8Array(8), 1, 1, 1, 4);
  add(23, 1, background ? new Uint8Array(background.data.buffer) : new Uint8Array(16), background?.width ?? 1, background?.height ?? 1, 1, 2);
  add(24, 1, new Uint8Array(lightData.buffer), lightWidth, lightHeight, 1, 2);
  add(25, 1, new Uint8Array(getOpenPbrEnergyLutData().buffer), OPENPBR_ENERGY_LUT_WIDTH, OPENPBR_ENERGY_LUT_HEIGHT, 1, 3);
  add(26, 1, new Uint8Array(new Float32Array([Number.MAX_SAFE_INTEGER]).buffer), 1, 1, 1, 3);
  add(30, 2, shader, 0, 0, 0, 0);
  let size = 16 + records.length * 32;
  for (const part of parts) size += Math.ceil(part.length / 4) * 4;
  const result = new Uint8Array(size), header = new Uint32Array(result.buffer);
  header.set([1, records.length, width, height]); let offset = 16 + records.length * 32;
  for (let i = 0; i < records.length; i++) {
    records[i][7] = offset; header.set(records[i], 4 + i * 8);
    result.set(parts[i], offset); offset += Math.ceil(parts[i].length / 4) * 4;
  }
  return result;
}

function nativeFloatImage(texture: PixelTexture | undefined): {width: number; height: number; data: Float32Array} | undefined {
  if (!texture) return undefined;
  const data = texture.pixels.data;
  if (!(data instanceof Float32Array)) throw new Error('Environment/background requires linear RGBA32F.');
  return {width: texture.pixels.width, height: texture.pixels.height, data};
}
