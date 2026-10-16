import { packMaterialBuffer } from '../../../src/renderer/materialLayout.js';
import type { BufferData } from '../../../src/renderer/materialBufferData.js';

export function materialParameters(bytes: Uint8Array): Uint8Array {
  const input = new Uint32Array(bytes.buffer, bytes.byteOffset, 3);
  const count = input[0], flags = input[1], seed = input[2];
  const data: BufferData = {
    color: [],
    type: [],
    roughness: [],
    normalMapIndex: [],
    normalScale: [],
    metallic: [],
    anisotropy: [],
    diffuseMapIndex: [],
    metallicRoughnessMapIndex: [],
    emission: [],
    emissiveMapIndex: [],
    ior: [],
    transmission: [],
    mediumType: [],
    thin: [],
    bevelSize: [],
    dispersion: [],
    thinFilmThickness: [],
    mapAlphaUsage: [],
    coatWeightMapIndex: [],
    coatRoughnessMapIndex: [],
    coatNormalMapIndex: [],
    fuzzColorMapIndex: [],
    uvProjection: [],
    displacementMapIndex: [],
    uvScale: [],
    displacementStepSize: [],
    displacementUvProjection: [],
    displacementUvProjectionScale: [],
    alpha: [],
    thinFilmMapIndex: [],
    thinFilmIor: [],
    transmissionMapIndex: [],
    baseWeight: [],
    baseDiffuseRoughness: [],
    specularWeight: [],
    subsurfaceWeight: [],
    specularColor: [],
    fuzzWeight: [],
    transmissionColor: [],
    transmissionDepth: [],
    transmissionScatter: [],
    transmissionScatterAnisotropy: [],
    subsurfaceColor: [],
    subsurfaceRadius: [],
    fuzzColor: [],
    fuzzRoughness: [],
    coatColor: [],
    coatWeight: [],
    coatRoughness: [],
    coatAnisotropy: [],
    coatIor: [],
    coatDarkening: [],
    thinFilmWeight: [],
    dispersionAbbeNumber: [],
    subsurfaceScatterAnisotropy: [],
    fuzzRoughnessMapIndex: [],
    subsurfaceRadiusScale: [],
    specularWeightMapIndex: [],
    mediumExtinction: [],
    mediumAnisotropy: [],
    mediumScattering: [],
    specularColorMapIndex: [],
    roughnessMapIndex: [],
    metalnessMapIndex: [],
    alphaMapIndex: [],
    alphaCutoff: [],
    doubleSided: [],
    alphaMode: [],
    anisotropyMapIndex: [],
    specularAnisotropyRotation: [],
    coatNormalScale: [],
    coatAnisotropyRotation: [],
    specularAnisotropyModel: [],
    thinFilmThicknessMinimum: [],
    thinFilmMapChannel: [],
    mapInfo: [],
    mapTransform: [],
    mapUvChannel: [],
    mapColorLinear: [],
  };
  for (let i = 0; i < count; i++) {
    const value = (seed + i * 7) * .03125;
    data.color.push([value + 0, value * .5, -value]);
    data.type.push(0);
    data.roughness.push(value + 2);
    if (!(flags & 2)) data.normalMapIndex.push(i % 5 - 1);
    data.normalScale.push(flags & 1 ? new Float32Array([value, value + 1]) : [value, value + 1]);
    data.metallic.push(value + 5);
    data.anisotropy.push(value + 6);
    if (!(flags & 2)) data.diffuseMapIndex.push(i % 5 - 1);
    if (!(flags & 2)) data.metallicRoughnessMapIndex.push(i % 5 - 1);
    data.emission.push([value + 9, value * .5, -value]);
    if (!(flags & 2)) data.emissiveMapIndex.push(i % 5 - 1);
    data.ior.push(value + 11);
    data.transmission.push(value + 12);
    data.mediumType.push(value + 13);
    data.thin.push(value + 14);
    data.bevelSize.push(value + 15);
    data.dispersion.push(value + 16);
    data.thinFilmThickness.push(value + 17);
    data.mapAlphaUsage.push(value + 18);
    if (!(flags & 2)) data.coatWeightMapIndex.push(i % 5 - 1);
    if (!(flags & 2)) data.coatRoughnessMapIndex.push(i % 5 - 1);
    if (!(flags & 2)) data.coatNormalMapIndex.push(i % 5 - 1);
    if (!(flags & 2)) data.fuzzColorMapIndex.push(i % 5 - 1);
    data.uvProjection.push(value + 23);
    if (!(flags & 2)) data.displacementMapIndex.push(i % 5 - 1);
    data.uvScale.push(flags & 1 ? new Float32Array([value, value + 1]) : [value, value + 1]);
    data.displacementStepSize.push(value + 26);
    data.displacementUvProjection.push(value + 27);
    data.displacementUvProjectionScale.push(value + 28);
    data.alpha.push(value + 29);
    if (!(flags & 2)) data.thinFilmMapIndex.push(i % 5 - 1);
    data.thinFilmIor.push(value + 31);
    if (!(flags & 2)) data.transmissionMapIndex.push(i % 5 - 1);
    data.baseWeight.push(value + 33);
    data.baseDiffuseRoughness.push(value + 34);
    data.specularWeight.push(value + 35);
    data.subsurfaceWeight.push(value + 36);
    data.specularColor.push([value + 37, value * .5, -value]);
    data.fuzzWeight.push(value + 38);
    data.transmissionColor.push([value + 39, value * .5, -value]);
    data.transmissionDepth.push(value + 40);
    data.transmissionScatter.push([value + 41, value * .5, -value]);
    data.transmissionScatterAnisotropy.push(value + 42);
    data.subsurfaceColor.push([value + 43, value * .5, -value]);
    data.subsurfaceRadius.push(value + 44);
    data.fuzzColor.push([value + 45, value * .5, -value]);
    data.fuzzRoughness.push(value + 46);
    data.coatColor.push([value + 47, value * .5, -value]);
    data.coatWeight.push(value + 48);
    data.coatRoughness.push(value + 49);
    data.coatAnisotropy.push(value + 50);
    data.coatIor.push(value + 51);
    data.coatDarkening.push(value + 52);
    data.thinFilmWeight.push(value + 53);
    data.dispersionAbbeNumber.push(value + 54);
    data.subsurfaceScatterAnisotropy.push(value + 55);
    if (!(flags & 2)) data.fuzzRoughnessMapIndex.push(i % 5 - 1);
    data.subsurfaceRadiusScale.push([value + 57, value * .5, -value]);
    if (!(flags & 2)) data.specularWeightMapIndex.push(i % 5 - 1);
    data.mediumExtinction.push([value + 59, value * .5, -value]);
    data.mediumAnisotropy.push(value + 60);
    data.mediumScattering.push([value + 61, value * .5, -value]);
    if (!(flags & 2)) data.specularColorMapIndex.push(i % 5 - 1);
    if (!(flags & 2)) data.roughnessMapIndex.push(i % 5 - 1);
    if (!(flags & 2)) data.metalnessMapIndex.push(i % 5 - 1);
    if (!(flags & 2)) data.alphaMapIndex.push(i % 5 - 1);
    data.alphaCutoff.push(value + 66);
    data.doubleSided.push(value + 67);
    data.alphaMode.push(value + 68);
    if (!(flags & 2)) data.anisotropyMapIndex.push(i % 5 - 1);
    data.specularAnisotropyRotation.push(value + 70);
    data.coatNormalScale.push(flags & 1 ? new Float32Array([value, value + 1]) : [value, value + 1]);
    data.coatAnisotropyRotation.push(value + 72);
    data.specularAnisotropyModel.push(value + 73);
    data.thinFilmThicknessMinimum.push(value + 74);
    data.thinFilmMapChannel.push(value + 75);
  }
  return new Uint8Array(packMaterialBuffer(data).buffer);
}
