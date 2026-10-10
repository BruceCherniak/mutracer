// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import OpenPBRMaterial, {
  materialAlphaModeConstants
} from '../../../scene/OpenPBRMaterial';

export function createMaterialBufferWgsl({
  hasSceneAlpha = true
}: {
  hasSceneAlpha?: boolean;
} = {}) {
  const alphaModeAssignment = hasSceneAlpha
    ? '(*ma).alphaMode = i32(matData.alphaMode);'
    : '';
  const alphaModeResolution = hasSceneAlpha
    ? /* wgsl */ `
  if ((*ma).alphaMode == ${materialAlphaModeConstants.opaque}) {
    (*ma).alpha = 1.0;
  }
  else if ((*ma).alphaMode == ${materialAlphaModeConstants.mask}) {
    (*ma).alpha = select(0.0, 1.0, (*ma).alpha >= matData.alphaCutoff);
  }`
    : '';

  return /* wgsl */ `

fn sRGBToLinear(c: vec3f) -> vec3f {
  return mix(pow(c * 0.9478672986 + 0.0521327014, vec3f(2.4)), c * 0.0773993808, vec3f(c < vec3f(0.04045)));
}

fn unpackMaterialIndex(val: i32) -> vec2f {
  return vec2f(f32(val >> 8), f32(val & 0xff) / 255.0);
}

fn getMapSize(idx: i32) -> vec2f {
  return mapInfo[idx].xy;
}

fn getMapLayer(idx: i32) -> i32 {
  return i32(floor(mapInfo[idx].z));
}

fn getMapOffset(idx: i32) -> vec2f {
  return vec2f(fract(mapInfo[idx].z), mapInfo[idx].w);
}

fn getMapUV(idx: i32, uv: vec2f) -> vec2f {
  let transform = mapInfo[idx + NUM_MAPS];
  let repeatedUv = fract(uv * transform.xy + transform.zw);
  let atlasTexel = 1.0 / vec2f(textureDimensions(map).xy);
  let firstTexelCenter = getMapOffset(idx);
  let sourceExtent = getMapSize(idx) + atlasTexel;
  let sourceOrigin = firstTexelCenter - 0.5 * atlasTexel;
  let lastTexelCenter = firstTexelCenter + sourceExtent - atlasTexel;
  return clamp(
    sourceOrigin + repeatedUv * sourceExtent,
    firstTexelCenter,
    lastTexelCenter
  );
}

fn getMapUvSet(idx: i32, uv: vec2f, uv1: vec2f) -> vec2f {
  return select(uv, uv1, mapInfo[idx + NUM_MAPS * 2].x > 0.5);
}

fn sampleMap(idx: i32, uv: vec2f) -> vec4f {
  return textureSampleLevel(map, mapSampler, getMapUV(idx, uv), getMapLayer(idx), 0.0);
}

fn getMapTexelStep(idx: i32) -> vec2f {
  let atlasSize = vec2f(textureDimensions(map).xy);
  let transform = abs(mapInfo[idx + NUM_MAPS].xy);
  let sourceSize = getMapSize(idx) * atlasSize + vec2f(1.0);
  let sourceSpan = max(sourceSize * transform, vec2f(1.0));
  return 1.0 / sourceSpan;
}


fn getMaterialEmission(materialIndex: i32, uv: vec2f, uv1: vec2f) -> vec3f {
  let matData = materialsBuffer[materialIndex];
  var emission = matData.emission;
  if (USE_EMISSIVE_MAPS) {
    let emissiveMapIndex = i32(matData.emissiveMapIndex);
    if (emissiveMapIndex >= 0) {
      emission *= sRGBToLinear(sampleMap(
        emissiveMapIndex, getMapUvSet(emissiveMapIndex, uv, uv1)
      ).rgb);
    }
  }
  return emission;
}

fn getMaterial(
  ma: ptr<function, OpenPbrResolvedMaterial>,
  materialIndex: i32,
  uv: vec2f,
  uv1: vec2f
) {
  let matData = materialsBuffer[materialIndex];

  (*ma).baseColor = matData.color;
  (*ma).materialType = i32(matData.matType);
  (*ma).specularRoughness = matData.roughness;
  (*ma).baseMetalness = matData.metallic;
  (*ma).specularAnisotropy = matData.anisotropy;
  (*ma).emission = getMaterialEmission(materialIndex, uv, uv1);
  (*ma).specularIor = matData.ior;
  (*ma).transmissionWeight = matData.transmission;
  (*ma).thinWalled = matData.thin > 0.5;
  (*ma).bevel = matData.bevel;
  (*ma).transmissionDispersionScale = matData.dispersion;
  (*ma).dispersionAbbeNumber = max(matData.dispersionAbbeNumber, 1e-6);
  (*ma).mediumExtinction = max(matData.mediumExtinction, vec3f(0.0));
  (*ma).mediumScattering = max(matData.mediumScattering, vec3f(0.0));
  (*ma).mediumAnisotropy = clamp(matData.mediumAnisotropy, -1.0, 1.0);
  (*ma).mediumType = select(0, 1, max(max((*ma).mediumExtinction.x, (*ma).mediumExtinction.y), (*ma).mediumExtinction.z) > 0.0);
  (*ma).alpha = matData.alpha;
  ${alphaModeAssignment}

  (*ma).thinFilmThickness = matData.thinFilmThickness * 1000.0;
  (*ma).thinFilmIor = matData.thinFilmIor;
  (*ma).thinFilmWeight = clamp(matData.thinFilmWeight, 0.0, 1.0);
  (*ma).baseWeight = clamp(matData.baseWeight, 0.0, 1.0);
  (*ma).diffuseRoughness = clamp(matData.baseDiffuseRoughness, 0.0, 1.0);
  (*ma).specularWeight = max(matData.specularWeight, 0.0);
  (*ma).specularColor = max(matData.specularColor, vec3f(0.0));
  (*ma).subsurfaceWeight = clamp(matData.subsurfaceWeight, 0.0, 1.0);
  (*ma).subsurfaceColor = max(matData.subsurfaceColor, vec3f(0.0));
  (*ma).transmissionColor = max(matData.transmissionColor, vec3f(0.0));
  (*ma).fuzzWeight = clamp(matData.fuzzWeight, 0.0, 1.0);
  (*ma).fuzzColor = max(matData.fuzzColor, vec3f(0.0));
  (*ma).fuzzRoughness = clamp(matData.fuzzRoughness, 0.0, 1.0);
  (*ma).coatWeight = clamp(matData.coatWeight, 0.0, 1.0);
  (*ma).coatColor = max(matData.coatColor, vec3f(0.0));
  (*ma).coatRoughness = clamp(matData.coatRoughness, ROUGHNESS_MIN, 1.0);
  (*ma).coatIor = max(matData.coatIor, 1.0);
  (*ma).coatDarkening = clamp(matData.coatDarkening, 0.0, 1.0);

  if (USE_DIFFUSE_MAPS) {
    let diffuseMapIndex = i32(matData.diffuseMapIndex);
    if (diffuseMapIndex >= 0) {
      // TODO textureSample is not supported in compute shader.
      let diffuse = sampleMap(
        diffuseMapIndex, getMapUvSet(diffuseMapIndex, uv, uv1)
      );
      // Material factors from THREE / glTF are already linear. Only color
      // textures need decoding from their stored sRGB values.
      (*ma).baseColor *= sRGBToLinear(diffuse.rgb);

      // Map alpha to transmission
      if (matData.mapAlphaUsage == ${OpenPBRMaterial.mapAlphaUsageTransmission}) {
        (*ma).transmissionWeight = 1.0 - diffuse.a;
      }
      else if (matData.mapAlphaUsage == ${OpenPBRMaterial.mapAlphaUsageAlpha}) {
        (*ma).alpha *= diffuse.a;
      }
    }
  }

  if (USE_ALPHA_MAPS) {
    let alphaMapIndex = i32(matData.alphaMapIndex);
    if (alphaMapIndex >= 0) {
      (*ma).alpha *= sampleMap(
        alphaMapIndex, getMapUvSet(alphaMapIndex, uv, uv1)
      ).g;
    }
  }

  ${alphaModeResolution}

  if (USE_TRANSMISSION_MAPS) {
    let transmissionMapIndex = i32(matData.transmissionMapIndex);
    if (transmissionMapIndex >= 0) {
      (*ma).transmissionWeight *= sampleMap(
        transmissionMapIndex, getMapUvSet(transmissionMapIndex, uv, uv1)
      ).r;
    }
  }

  if (USE_METALLIC_ROUGHNESS_MAPS) {
    // Metallic roughness transmission map index
    let mrtMapIndex = i32(matData.mrtMapIndex);
    if (mrtMapIndex >= 0) {
      let metallicRoughness = sampleMap(
        mrtMapIndex, getMapUvSet(mrtMapIndex, uv, uv1)
      );
      (*ma).baseMetalness *= metallicRoughness.b;
      (*ma).specularRoughness *= metallicRoughness.g;
    }
  }

  if (USE_ROUGHNESS_MAPS) {
    let roughnessMapIndex = i32(matData.roughnessMapIndex);
    if (roughnessMapIndex >= 0) {
      (*ma).specularRoughness *= sampleMap(
        roughnessMapIndex, getMapUvSet(roughnessMapIndex, uv, uv1)
      ).g;
    }
  }

  if (USE_METALNESS_MAPS) {
    let metalnessMapIndex = i32(matData.metalnessMapIndex);
    if (metalnessMapIndex >= 0) {
      (*ma).baseMetalness *= sampleMap(
        metalnessMapIndex, getMapUvSet(metalnessMapIndex, uv, uv1)
      ).b;
    }
  }

  if (USE_THIN_FILM_MAPS) {
    let thinFilmMapIndex = i32(matData.thinFilmMapIndex);
    if (thinFilmMapIndex >= 0) {
      (*ma).thinFilmThickness *= sampleMap(
        thinFilmMapIndex, getMapUvSet(thinFilmMapIndex, uv, uv1)
      ).r;
    }
  }

  (*ma).specularRoughness = clamp((*ma).specularRoughness, ROUGHNESS_MIN, 1.0);
  (*ma).baseMetalness = clamp((*ma).baseMetalness, 0.0, 1.0);
  let aspect: f32 = sqrt(1.0 - (*ma).specularAnisotropy * 0.9);
  let specularAlpha = (*ma).specularRoughness * (*ma).specularRoughness;
  // GGX alpha is squared perceptual roughness. Clamp it in the same domain;
  // reusing ROUGHNESS_MIN directly here turns a nominally smooth surface into
  // sqrt(ROUGHNESS_MIN) roughness and visibly broadens thick-glass transport.
  let alphaMin = ROUGHNESS_MIN * ROUGHNESS_MIN;
  (*ma).alphaX = max(alphaMin, specularAlpha / aspect);
  (*ma).alphaY = max(alphaMin, specularAlpha * aspect);
}

fn getMatNormal(materialIndex: i32, uv: vec2f, bumpUv: vec2f, normal: vec3f, dp1: vec3f, dp2: vec3f, duv1: vec2f, duv2: vec2f) -> vec3f {
  let matData = materialsBuffer[materialIndex];
  let normalMapIndex = i32(matData.normalMapIndex);
  let bumpMapIndex = i32(matData.bumpMapIndex);
  if (normalMapIndex >= 0 || bumpMapIndex >= 0) {
    // http://www.thetenthplanet.de/archives/1180
    // TODO use tangent attribute
    // Compute co-tangent and co-bitangent vectors
    let dp2perp = cross(dp2, normal);
    let dp1perp = cross(normal, dp1);
    var dpdu = dp2perp * duv1.x + dp1perp * duv2.x;
    var dpdv = dp2perp * duv1.y + dp1perp * duv2.y;
    let gradientLengthSquared = max(dot(dpdu, dpdu), dot(dpdv, dpdv));
    if (gradientLengthSquared > 1e-12) {
      let invmax = inverseSqrt(gradientLengthSquared);
      dpdu *= invmax;
      dpdv *= invmax;
    }
    else {
      // Generated/triplanar UVs have no per-vertex UV derivatives. Build a
      // stable fallback basis instead of normalizing two zero vectors.
      let referenceAxis = select(
        vec3f(0.0, 1.0, 0.0),
        vec3f(0.0, 0.0, 1.0),
        abs(normal.z) < 0.999
      );
      dpdu = normalize(cross(referenceAxis, normal));
      dpdv = cross(normal, dpdu);
    }

    var n = vec3f(0.0, 0.0, 1.0);
    if (normalMapIndex >= 0) {
      n = 2.0 * sampleMap(normalMapIndex, uv).rgb - 1.0;
      n = vec3(n.xy * matData.normalMapScale, n.z);
    }
    if (bumpMapIndex >= 0 && matData.bumpStrength > 0.0) {
      let texel = getMapTexelStep(bumpMapIndex);
      let heightLeft = sampleMap(bumpMapIndex, bumpUv - vec2f(texel.x, 0.0)).r;
      let heightRight = sampleMap(bumpMapIndex, bumpUv + vec2f(texel.x, 0.0)).r;
      let heightDown = sampleMap(bumpMapIndex, bumpUv - vec2f(0.0, texel.y)).r;
      let heightUp = sampleMap(bumpMapIndex, bumpUv + vec2f(0.0, texel.y)).r;
      n = vec3f(
        n.xy + vec2f(heightLeft - heightRight, heightDown - heightUp) * matData.bumpStrength,
        n.z
      );
    }
    n = normalize(n);

    let tbn = mat3x3(dpdu, dpdv, normal);

    return normalize(tbn * n);
  } else {
    return normal;
  }
}
`;
}

const materialBufferWgsl = createMaterialBufferWgsl();

export default materialBufferWgsl;
