import { simpleTextureSample, thinFilmTextureSample } from '../../materialTextureSlots.js';
import { materialRowsGlsl } from '../../materialLayout.js';
import { materialAlphaModeConstants } from '../../../scene/OpenPBRMaterial.js';
import { mapAlphaUsageConstants } from '../../materialConstants.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import { createShaderMixin, glsl, Shader } from '../../shader.js';

export default createShaderMixin({
  uniforms: {
    materialBuffer: Shader.uniform('sampler2D'),
    materialBufferColumns: Shader.uniform('int', 1),
    mapInfo: Shader.arrayUniform('vec4', 'NUM_MAPS'),
    mapTransform: Shader.arrayUniform('vec4', 'NUM_MAPS'),
    mapUvChannel: Shader.arrayUniform('float', 'NUM_MAPS'),
    map: Shader.uniform('sampler2DArray')
  },
  defines: {
    NUM_MATERIALS: 1
  },
  main: glsl`
${materialRowsGlsl()}
vec3 sRGBToLinear(vec3 c) {
  return mix(pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), c * 0.0773993808, vec3(lessThan(c, vec3(0.04045))));
}
vec4 fetchMatData(int i) {
  return fetchData(materialBuffer, i, materialBufferColumns);
}

// Shared by surface evaluation and shadow occlusion, after texture factors.
float resolveMaterialAlpha(float alpha, int alphaMode, float alphaCutoff) {
  if (alphaMode == ${materialAlphaModeConstants.opaque}) {
    return 1.0;
  }
  if (alphaMode == ${materialAlphaModeConstants.mask}) {
    return alpha >= alphaCutoff ? 1.0 : 0.0;
  }
  return alpha;
}

float getMatType(int idx) {
  return fetchMatData(idx * MAT_DATA_SIZE + MAT_ROW_COLOR).w;
}

vec2 unpackMaterialIndex(int val) {
  return vec2(float(val >> 8), float(val & 0xff) / 255.0);
}

#ifdef NUM_MAPS
vec2 getMapSize(int index) {
  return mapInfo[index].xy;
}

float getMapLayer(int index) {
  return floor(mapInfo[index].z);
}

vec2 getMapOffset(int index) {
  return vec2(fract(mapInfo[index].z), mapInfo[index].w);
}

vec2 getMapUV(int index, vec2 uv) {
  vec4 transform = mapTransform[index];
  vec2 repeatedUv = fract(uv * transform.xy + transform.zw);
  vec2 atlasTexel = 1.0 / vec2(textureSize(map, 0).xy);
  vec2 firstTexelCenter = getMapOffset(index);
  vec2 sourceExtent = getMapSize(index) + atlasTexel;
  vec2 sourceOrigin = firstTexelCenter - 0.5 * atlasTexel;
  vec2 lastTexelCenter = firstTexelCenter + sourceExtent - atlasTexel;
  return clamp(
    sourceOrigin + repeatedUv * sourceExtent,
    firstTexelCenter,
    lastTexelCenter
  );
}

vec2 getMapUvSet(int index, vec2 uv, vec2 uv1) {
  return mapUvChannel[index] > 0.5 ? uv1 : uv;
}

vec4 sampleMap(int index, vec2 uv) {
  return texture(map, vec3(getMapUV(index, uv), getMapLayer(index)));
}

vec2 getMapTexelStep(int index) {
  vec2 atlasSize = vec2(textureSize(map, 0).xy);
  vec2 transform = abs(mapTransform[index].xy);
  vec2 sourceSize = getMapSize(index) * atlasSize + vec2(1.0);
  vec2 sourceSpan = max(sourceSize * transform, vec2(1.0));
  return 1.0 / sourceSpan;
}
#endif

// OpenPBR 1.1.1: RMS-preserving GGX anisotropy, shared by base and coat.
vec2 openpbr_roughness_to_alpha(float roughness, float anisotropy) {
  float alpha = roughness * roughness;
  float alphaMin = ROUGHNESS_MIN * ROUGHNESS_MIN;
  if (anisotropy == 0.0) { return vec2(max(alphaMin, alpha)); }
  float complement = 1.0 - anisotropy;
  float alphaT = alpha * sqrt(2.0 / (1.0 + complement * complement));
  return max(vec2(alphaMin), vec2(alphaT, complement * alphaT));
}

void getMaterial(
  inout OpenPbrResolvedMaterial mat,
  int materialIndex,
  vec2 uv,
  vec2 uv1
) {
  int i = materialIndex * MAT_DATA_SIZE;
  vec4 colorAndMatType = fetchMatData(i + MAT_ROW_COLOR);
  vec4 roughnessAndNormal = fetchMatData(i + MAT_ROW_ROUGHNESS_NORMAL);
  vec4 metallicAndMapIndex = fetchMatData(i + MAT_ROW_METALLIC_MAPS);
  vec4 emissionAndEmissiveMapIndex = fetchMatData(i + MAT_ROW_EMISSION);
  vec4 iorAndTransmission = fetchMatData(i + MAT_ROW_IOR_TRANSMISSION);
  vec4 misc = fetchMatData(i + MAT_ROW_MISC);
  vec4 alphaAndThinFilm = fetchMatData(i + MAT_ROW_ALPHA_FILM);
  vec4 baseControls = fetchMatData(i + MAT_ROW_BASE_CONTROLS);
  vec4 specularAndFuzz = fetchMatData(i + MAT_ROW_SPECULAR_FUZZ);
  vec4 subsurface = fetchMatData(i + MAT_ROW_SUBSURFACE);
  vec4 fuzz = fetchMatData(i + MAT_ROW_FUZZ);
  vec4 coat = fetchMatData(i + MAT_ROW_COAT);
  vec4 coatControls = fetchMatData(i + MAT_ROW_COAT_CONTROLS);
  vec4 filmAndDispersion = fetchMatData(i + MAT_ROW_FILM_DISPERSION);
  vec4 standaloneMetalRoughMaps = fetchMatData(i + MAT_ROW_STANDALONE_MAPS);
  int mapAlphaUsage = int(misc.a);

  mat.baseColor = colorAndMatType.rgb;
  mat.materialType = int(colorAndMatType.w);
  mat.specularRoughness = roughnessAndNormal.x;
  mat.baseMetalness = metallicAndMapIndex.x;
  mat.specularAnisotropy = clamp(metallicAndMapIndex.y, 0.0, 1.0);
  mat.emission = emissionAndEmissiveMapIndex.rgb;
  mat.inside = false;
  mat.specularIor = iorAndTransmission.x;
  mat.transmissionWeight = iorAndTransmission.y;
#ifdef HAS_MEDIUM
  mat.mediumType = int(iorAndTransmission.z);
#else
  mat.mediumType = 0;
#endif
  mat.thinWalled = iorAndTransmission.w > 0.5;
  mat.bevel = misc.r;
  mat.transmissionDispersionScale = misc.g;
  mat.dispersionAbbeNumber = max(filmAndDispersion.y, 1e-6);
  mat.thinFilmThickness = misc.b;
  mat.thinFilmIor = alphaAndThinFilm.b;
  mat.thinFilmWeight = clamp(filmAndDispersion.x, 0.0, 1.0);
  // OpenPBR specifies micrometres; the interference routine uses nanometres.
  mat.thinFilmThickness *= 1000.0;
  mat.baseWeight = clamp(baseControls.x, 0.0, 1.0);
  mat.diffuseRoughness = clamp(baseControls.y, 0.0, 1.0);
  mat.specularWeight = max(0.0, baseControls.z);
  mat.subsurfaceWeight = clamp(baseControls.w, 0.0, 1.0);
  mat.specularColor = max(specularAndFuzz.rgb, vec3(0.0));
  mat.fuzzWeight = clamp(specularAndFuzz.w, 0.0, 1.0);
  mat.subsurfaceColor = max(subsurface.rgb, vec3(0.0));
  mat.transmissionColor = max(fetchMatData(i + MAT_ROW_TRANSMISSION_COLOR).rgb, vec3(0.0));
  mat.fuzzColor = max(fuzz.rgb, vec3(0.0));
  mat.fuzzRoughness = clamp(fuzz.w, 0.0, 1.0);
  mat.coatColor = max(coat.rgb, vec3(0.0));
  mat.coatWeight = clamp(coat.w, 0.0, 1.0);
  mat.coatRoughness = clamp(coatControls.x, ROUGHNESS_MIN, 1.0);
  mat.coatAnisotropy = clamp(coatControls.y, 0.0, 1.0);
  mat.coatIor = max(coatControls.z, 1.0);
  mat.coatDarkening = clamp(coatControls.w, 0.0, 1.0);

#ifdef HAS_MEDIUM
  mat.mediumExtinction = max(fetchMatData(i + MAT_ROW_MEDIUM_EXTINCTION).rgb, vec3(0.0));
  mat.mediumAnisotropy = clamp(fetchMatData(i + MAT_ROW_MEDIUM_EXTINCTION).a, -1.0, 1.0);
  mat.mediumScattering = max(fetchMatData(i + MAT_ROW_MEDIUM_SCATTERING).rgb, vec3(0.0));
  mat.mediumType = max(max(mat.mediumExtinction.x, mat.mediumExtinction.y), mat.mediumExtinction.z) > 0.0 ? 1 : 0;
#endif


#ifdef HAS_ALPHA
  mat.alpha = alphaAndThinFilm.r;
#else
  mat.alpha = 1.0;
#endif

  #ifdef NUM_DIFFUSE_MAPS
    int diffuseMapIndex = int(metallicAndMapIndex.z);
    if (diffuseMapIndex >= 0) {
      vec4 diffuse = sampleMap(
        diffuseMapIndex, getMapUvSet(diffuseMapIndex, uv, uv1)
      );
      // Material factors from THREE / glTF are already linear. Only color
      // textures need decoding from their stored sRGB values.
      mat.baseColor *= sRGBToLinear(diffuse.rgb);

      // Map alpha to transmission
      if (mapAlphaUsage == ${mapAlphaUsageConstants.transmission + ''}) {
        mat.transmissionWeight = 1.0 - diffuse.a;
      }
      else if (mapAlphaUsage == ${mapAlphaUsageConstants.alpha + ''}) {
        mat.alpha *= diffuse.a;
      }
    }
  #endif

  ${simpleTextureSample('alphaMap', 'glsl')}

  mat.alpha = resolveMaterialAlpha(
    mat.alpha, int(fetchMatData(i + MAT_ROW_BUMP_ALPHA).w), standaloneMetalRoughMaps.w
  );

  ${simpleTextureSample('transmissionMap', 'glsl')}

  #ifdef NUM_METALLIC_ROUGHNESS_MAPS
    int metallicRoughnessMapIndex = int(metallicAndMapIndex.w);
    if (metallicRoughnessMapIndex >= 0) {
      vec4 metallicRoughness = sampleMap(
        metallicRoughnessMapIndex,
        getMapUvSet(metallicRoughnessMapIndex, uv, uv1)
      );
      mat.baseMetalness *= metallicRoughness.b;
      mat.specularRoughness *= metallicRoughness.g;
    }
  #endif

  ${simpleTextureSample('roughnessMap', 'glsl')}

  ${simpleTextureSample('metalnessMap', 'glsl')}

  #ifdef NUM_EMISSIVE_MAPS
    int emissiveMapIndex = int(emissionAndEmissiveMapIndex.w);
    if (emissiveMapIndex >= 0) {
      vec3 emissive = sampleMap(
        emissiveMapIndex, getMapUvSet(emissiveMapIndex, uv, uv1)
      ).rgb;
      mat.emission *= sRGBToLinear(emissive);
    }
  #endif

  #ifdef NUM_COAT_WEIGHT_MAPS
    int emissionCoatMapIndex = int(fetchMatData(i + MAT_ROW_LAYER_MAPS).x);
    if (emissionCoatMapIndex >= 0 && mat.materialType == 0) {
      float emissionCoatWeight = clamp(coat.w, 0.0, 1.0) * sampleMap(
        emissionCoatMapIndex, getMapUvSet(emissionCoatMapIndex, uv, uv1)
      ).r;
      mat.emission *= mix(vec3(1.0), sqrt(max(coat.rgb, vec3(0.0))), emissionCoatWeight);
    }
  #endif

  ${thinFilmTextureSample('glsl')}

  ${simpleTextureSample('coatWeightMap', 'glsl')}

  ${simpleTextureSample('coatRoughnessMap', 'glsl')}

  ${simpleTextureSample('fuzzColorMap', 'glsl')}

  ${simpleTextureSample('fuzzRoughnessMap', 'glsl')}

  ${simpleTextureSample('specularWeightMap', 'glsl')}

  ${simpleTextureSample('specularColorMap', 'glsl')}

  // OpenPBR 1.1.1: coat refraction broadens all base microfacet lobes.
  // Keep the zero-coat / smooth-coat paths byte-identical.
  if (mat.coatWeight > 0.0 && mat.coatRoughness > 0.0) {
    float baseRoughness2 = mat.specularRoughness * mat.specularRoughness;
    float coatRoughness2 = mat.coatRoughness * mat.coatRoughness;
    mat.specularRoughness = mix(mat.specularRoughness,
      pow(min(1.0, baseRoughness2 * baseRoughness2 + 2.0 * coatRoughness2 * coatRoughness2), 0.25), mat.coatWeight);
  }
  mat.specularRoughness = clamp(mat.specularRoughness, ROUGHNESS_MIN, 1.0);
  mat.baseMetalness = clamp(mat.baseMetalness, 0.0, 1.0);
  vec2 specularAlpha = openpbr_roughness_to_alpha(mat.specularRoughness, mat.specularAnisotropy);
  mat.alphaX = specularAlpha.x;
  mat.alphaY = specularAlpha.y;
}

#if defined(NUM_NORMAL_MAPS) || defined(NUM_BUMP_MAPS)
vec3 getMatNormal(int materialIndex, vec2 uv, vec2 bumpUv, vec3 normal, vec3 dp1, vec3 dp2, vec2 duv1, vec2 duv2) {
  int i = materialIndex * MAT_DATA_SIZE;
  vec4 roughnessAndNormal = fetchMatData(i + MAT_ROW_ROUGHNESS_NORMAL);
  int normalMapIndex = int(roughnessAndNormal.y);
  vec4 bump = fetchMatData(i + MAT_ROW_BUMP_ALPHA);
  int bumpMapIndex = int(bump.x);
  float bumpStrength = bump.y;
  if (normalMapIndex >= 0 || bumpMapIndex >= 0) {
    // http://www.thetenthplanet.de/archives/1180
    // TODO use tangent attribute
    // Compute co-tangent and co-bitangent vectors
    vec3 dp2perp = cross(dp2, normal);
    vec3 dp1perp = cross(normal, dp1);
    vec3 dpdu = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 dpdv = dp2perp * duv1.y + dp1perp * duv2.y;
    float gradientLengthSquared = max(dot(dpdu, dpdu), dot(dpdv, dpdv));
    if (gradientLengthSquared > 1e-12) {
      float invmax = inversesqrt(gradientLengthSquared);
      dpdu *= invmax;
      dpdv *= invmax;
    }
    else {
      // Imported meshes can legitimately omit UVs and use generated or
      // triplanar projection. Their zero UV derivatives must not turn the TBN
      // basis (and then every lighting result) into NaN.
      vec3 referenceAxis = abs(normal.z) < 0.999
        ? vec3(0.0, 0.0, 1.0)
        : vec3(0.0, 1.0, 0.0);
      dpdu = normalize(cross(referenceAxis, normal));
      dpdv = cross(normal, dpdu);
    }

    vec3 n = vec3(0.0, 0.0, 1.0);
    if (normalMapIndex >= 0) {
      n = 2.0 * sampleMap(normalMapIndex, uv).rgb - 1.0;
      n.xy *= roughnessAndNormal.zw;
    }
    if (bumpMapIndex >= 0 && bumpStrength > 0.0) {
      vec2 texel = getMapTexelStep(bumpMapIndex);
      float heightLeft = sampleMap(bumpMapIndex, bumpUv - vec2(texel.x, 0.0)).r;
      float heightRight = sampleMap(bumpMapIndex, bumpUv + vec2(texel.x, 0.0)).r;
      float heightDown = sampleMap(bumpMapIndex, bumpUv - vec2(0.0, texel.y)).r;
      float heightUp = sampleMap(bumpMapIndex, bumpUv + vec2(0.0, texel.y)).r;
      n.xy += vec2(heightLeft - heightRight, heightDown - heightUp) * bumpStrength;
    }
    n = normalize(n);

    mat3 tbn = mat3(dpdu, dpdv, normal);

    return normalize(tbn * n);
  } else {
    return normal;
  }
}
#endif

`
});
