import MaterialState, { getMaterialHashKey, resetMaterialTextureId } from '../../../src/scene/MaterialState.js';
import PixelTexture from '../../../src/scene/PixelTexture.js';
import type TextureState from '../../../src/scene/TextureState.js';
import type { TextureDataSource } from '../../../src/scene/textureData.js';
import { writePixel } from '../../../src/scene/texturePixels.js';
import MaterialData from '../../../src/renderer/MaterialData.js';
import { writeRawAtlasPlacement } from '../../../src/renderer/textureAtlasPixels.js';

export function materialDataParameters(bytes: Uint8Array): Uint8Array {
  const input = new Uint32Array(bytes.buffer, bytes.byteOffset, 2);
  const count = input[0], flags = input[1];
  resetMaterialTextureId();
  const textures: PixelTexture[] = [];
  for (let t = 0; t < 3; t++) {
    const width = t + 2, height = 5 - t, storage = (flags + t) % 4;
    let data: TextureDataSource['data'];
    if (storage === 0) data = new Float32Array(width * height * 4);
    else if (storage === 1) data = new Int32Array(width * height * 4);
    else if (storage === 2) data = new Uint8Array(width * height * 4);
    else data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height * 4; i++) writePixel(data, i, storage === 0 ? (i % 13 - 2) * .25 : (i * 31) % 256);
    const texture = new PixelTexture({data, width, height});
    texture.flipY = !!(flags & 1); texture.uvScale = [t + .5, t + 1];
    texture.uvOffset = [.125 * t, -.25]; texture.uvChannel = t % 2 ? 1 : 0;
    textures.push(texture);
  }
  const materials: MaterialState[] = [];
  for (let i = 0; i < count; i++) {
    const x = (flags * 7 + i) / 31;
    const material = new MaterialState({
      baseColor: [x, .5, 1], baseMetalness: x, specularRoughness: x,
      geometryThinWalled: !!(flags & 1), transmissionWeight: x,
      transmissionDepth: flags % 3 ? x : 0, transmissionColor: [0, x, 2],
      transmissionScatter: [x, -.5, .5], transmissionScatterAnisotropy: x - 1,
      subsurfaceWeight: .75, subsurfaceRadius: x, subsurfaceColor: [.2, x, 1],
      subsurfaceRadiusScale: [x, .5, 1], subsurfaceScatterAnisotropy: x - .75,
      emissionColor: [1, .5, x], emissionLuminance: x,
      coatWeight: .75, coatColor: [.25, .5, 1],
      unlit: !!(flags & 4), shadowCatcher: !!(flags & 8),
      normalScale: flags & 16 ? new Float32Array([.25, .75]) : [.25, .75],
      alphaMode: flags & 32 ? 'mask' : 'auto', alphaCutoff: .25,
      geometryOpacity: .75, specularAnisotropyModel: flags & 2 ? 'gltf' : 'openpbr'
    });
    if (flags & 2) {
      material.map = textures[(0 + i) % 3];
      material.alphaMap = textures[(1 + i) % 3];
      material.normalMap = textures[(2 + i) % 3];
      material.emissiveMap = textures[(3 + i) % 3];
      material.metallicRoughnessMap = textures[(4 + i) % 3];
      material.roughnessMap = textures[(5 + i) % 3];
      material.metalnessMap = textures[(6 + i) % 3];
      material.transmissionMap = textures[(7 + i) % 3];
      material.thinFilmMap = textures[(8 + i) % 3];
      material.displacementMap = textures[(9 + i) % 3];
      material.coatWeightMap = textures[(10 + i) % 3];
      material.coatRoughnessMap = textures[(11 + i) % 3];
      material.fuzzColorMap = textures[(12 + i) % 3];
      material.fuzzRoughnessMap = textures[(13 + i) % 3];
      material.specularWeightMap = textures[(14 + i) % 3];
      material.specularColorMap = textures[(15 + i) % 3];
      material.anisotropyMap = textures[(16 + i) % 3];
      material.coatNormalMap = textures[(17 + i) % 3];

    }
    materials.push(material);
  }
  const lightTextures: (TextureState | undefined)[] = flags & 8 ? [textures[0], undefined, textures[0]] : [];
  const table = new MaterialData(materials, lightTextures, texture => {
    if (!(texture instanceof PixelTexture)) throw new Error('Expected pixel texture.');
    return Number(!(texture.pixels.data instanceof Uint8Array) && !(texture.pixels.data instanceof Uint8ClampedArray));
  }, flags & 64 ? {maxTextureDimension2D: 4, maxTextureArrayLayers: 1, maxTextureArrayBytes: 128} : {});
  const before = new Uint8Array(table.getBufferArray().buffer).slice();
  if (materials.length) { materials[0].transmissionWeight = .25; materials[0].specularRoughnessAnisotropy = .4; }
  table.repackParams(materials);
  const after = new Uint8Array(table.getBufferArray().buffer);
  const rawPages: Uint8Array[] = [];
  for (const page of table.atlas.pages) {
    const data = table.atlas.floatStorage ? new Uint16Array(table.atlas.width * table.atlas.height * 4)
      : new Uint8Array(table.atlas.width * table.atlas.height * 4);
    for (const placement of page.placements) {
      const texture = table.textures[placement.index];
      if (!(texture instanceof PixelTexture)) throw new Error('Expected pixel texture.');
      writeRawAtlasPlacement(data, table.atlas.width, placement, {image: texture.pixels, flipY: texture.flipY}, table.atlas.floatStorage);
    }
    rawPages.push(new Uint8Array(data instanceof Uint16Array ? data.buffer : data.buffer));
  }
  const oldHash = materials.map(getMaterialHashKey).join('|');
  const firstTexture = textures[0]; firstTexture.markUpdated();
  const hashes = new TextEncoder().encode(oldHash + '\n' + materials.map(getMaterialHashKey).join('|'));
  const metadata = new Float64Array([
    ...table.bufferData.mapInfo, ...table.bufferData.mapTransform, ...table.bufferData.mapUvChannel,
    ...table.bufferData.mapColorLinear, ...table.lightTexturesIndices,
    ...Object.keys(table.defines).map(key => table.defines[key]),
    table.atlas.stats.width, table.atlas.stats.height, table.atlas.stats.layers,
    table.atlas.stats.estimatedBytes, table.atlas.stats.scale, table.atlas.stats.sourcePixels,
    table.displacementMaps.length
  ]);
  const size = 32 + before.length + after.length + metadata.byteLength + hashes.length
    + rawPages.reduce((sum, page) => sum + page.length, 0);
  const result = new Uint8Array(size), header = new Uint32Array(result.buffer, 0, 8);
  header.set([1, before.length, after.length, metadata.byteLength, hashes.length, rawPages.length,
    table.atlas.width, table.atlas.height]);
  let offset = 32;
  for (const part of [before, after, new Uint8Array(metadata.buffer), hashes, ...rawPages]) {
    result.set(part, offset); offset += part.length;
  }
  return result;
}
