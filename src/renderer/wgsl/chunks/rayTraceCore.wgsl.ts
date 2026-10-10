import { ShadowCatcherMaterial, UnlitMaterial } from '../../../constants.js';
import {
  CONSTANT_DIRECTIONAL_LIGHT,
  CONSTANT_RECT_LIGHT,
  CONSTANT_SPHERE_LIGHT,
  CONSTANT_SPOT_LIGHT
} from '../../lightsUtil.js';
import { USE_TFDM_DISPLACEMENT } from '../../MergedMaterialData.js';

export default function rayTraceCore({
  hasDisplacement,
  hasSceneAlpha = true
}: {
  hasDisplacement: boolean;
  hasSceneAlpha?: boolean;
}) {
  return /*wgsl*/ `
// https://www.w3.org/WAI/GL/wiki/Relative_luminance
const luminance = vec3f(0.2126, 0.7152, 0.0722);
const RAY_MAX_DISTANCE = 9999.0;

const STANDARD = 0;
const UNLIT = ${UnlitMaterial};
const SHADOW_CATCHER = ${ShadowCatcherMaterial};

const RECT_LIGHT = ${CONSTANT_RECT_LIGHT};
const SPHERE_LIGHT = ${CONSTANT_SPHERE_LIGHT};
const DIRECTIONAL_LIGHT = ${CONSTANT_DIRECTIONAL_LIGHT};
const SPOT_LIGHT = ${CONSTANT_SPOT_LIGHT};

struct Ray {
  o: vec3f,
  d: vec3f,
};

struct SurfaceInteraction {
  position: vec3f,
  // For perfect specular or transmission surface
  // We use the albedo and normal of first diffuse or glossy surface hit instead for denoising
  // See albedo section in https://www.openimagedenoise.org/documentation.html
  albedoSampled: bool,

  normal: vec3f, // material shading normal
  vertexNormal: vec3f, // interpolated mesh normal before normal mapping
  shadowOffset: vec3f, // smooth-surface offset for direct-light shadow rays

  faceNormal: vec3f, // normal of the triangle
  hit: bool,

  tangent: vec3f,
  uv: vec2f,
  uv1: vec2f,

  triangleIndex: i32,
  instanceIndex: i32,
  materialIndex: i32,
  barycentrics: vec2f,

  wavelength: f32,

  mediumType: i32,
  mediumExtinction: vec3f,
  mediumScattering: vec3f,
  mediumAnisotropy: f32,

};

// Texture-resolved OpenPBR inputs used by the surface integrator. The storage
// buffer keeps its compact legacy layout; getMaterial() is the compatibility
// boundary that maps it to these canonical names.
struct OpenPbrResolvedMaterial {
  baseColor: vec3f,
  transmissionWeight: f32,

  emission: vec3f,
  specularAnisotropy: f32,

  baseMetalness: f32,
  specularIor: f32,
  specularRoughness: f32,

  transmissionDispersionScale: f32,
  dispersionAbbeNumber: f32,
  thinFilmThickness: f32,
  thinFilmIor: f32,
  thinFilmWeight: f32,

  // Medium
  mediumType: i32,
  mediumExtinction: vec3f,
  mediumScattering: vec3f,
  mediumAnisotropy: f32,

  baseWeight: f32,
  diffuseRoughness: f32,
  specularWeight: f32,
  specularColor: vec3f,
  subsurfaceWeight: f32,
  subsurfaceColor: vec3f,
  transmissionColor: vec3f,
  fuzzWeight: f32,
  fuzzColor: vec3f,
  fuzzRoughness: f32,
  coatWeight: f32,
  coatColor: vec3f,
  coatRoughness: f32,
  coatIor: f32,
  coatDarkening: f32,

  // Alpha
  alpha: f32,
  ${hasSceneAlpha ? 'alphaMode: i32,' : ''}

  materialType: i32,

  bevel: f32,

  relativeIor: f32,

  alphaX: f32,
  alphaY: f32,
  thinWalled: bool,
};

struct Path {
  ray: Ray,
  li: vec3f,
  alpha: f32,
  beta: vec3f,
  fromEye: bool,
  abort: bool,
  scatteringPdf: f32,
  isNextRefraction: bool,
};

struct LightSampleRec {
  normal: vec3f,
  emission: vec3f,
  direction: vec3f,
  dist: f32,
  pdf: f32,
  // Discrete probability of selecting this light before sampling its
  // conditional point/direction. Light RIS excludes this term from the target
  // and carries it in the unbiased contribution weight instead.
  selectionPmf: f32,
  isDelta: bool,
  // Light source type: environment=0, emissive triangle=1, analytic=2.
  sourceType: u32,
  sourceIndex: u32,
};

struct Light {
  position: vec3f,
  litType: f32,

  emission: vec3f,
  area: f32,

  u: vec3f,
  // Radius for sphere light, spread for rect light
  radiusOrSpread: f32,

  v: vec3f,
  textureIndex: f32,

  selectionPmf: f32,
  _samplingPadding0: f32,
  _samplingPadding1: f32,
  _samplingPadding2: f32,
};

struct EmissiveTriangle {
  p0: vec3f,
  selectionPmf: f32,
  p1: vec3f,
  area: f32,
  p2: vec3f,
  materialIndex: f32,
  uv0: vec2f,
  uv1: vec2f,
  uv2: vec2f,
  secondaryUv0: vec2f,
  secondaryUv1: vec2f,
  secondaryUv2: vec2f,
};

struct LightChoice {
  probability: f32,
  aliasIndex: i32,
  sourceType: i32,
  sourceIndex: i32,
};

struct MaterialBuffer {
  color: vec3f,
  matType: f32,

  roughness: f32,
  normalMapIndex: f32,
  normalMapScale: vec2f,

  metallic: f32,
  anisotropy: f32,
  diffuseMapIndex: f32,
  // Metallic roughness transmission map index
  mrtMapIndex: f32,

  emission: vec3f,
  emissiveMapIndex: f32,

  ior: f32,
  transmission: f32,
  mediumType: f32,
  thin: f32,

  bevel: f32,
  dispersion: f32,
  thinFilmThickness: f32,
  mapAlphaUsage: f32,

  // Medium
  mediumColor: vec3f,
  mediumDensity: f32,

  // UV
  uvProjection: f32,
  displacementMapIndex: f32,
  uvScale: vec2f,

  // Displacement
  ${
    USE_TFDM_DISPLACEMENT
      ? /*wgsl*/ `
  minmaxMapIndex: f32,
  minmaxMapSize: f32,`
      : /*wgsl*/ `
  displacementStepSize: f32,
  _padding: f32,`
  }

  displacementUvProjection: f32,
  displacementUvScale: f32,

  // Alpha
  alpha: f32,
  thinFilmMapIndex: f32,
  thinFilmIor: f32,
  transmissionMapIndex: f32,

  baseWeight: f32,
  baseDiffuseRoughness: f32,
  specularWeight: f32,
  subsurfaceWeight: f32,

  specularColor: vec3f,
  fuzzWeight: f32,

  transmissionColor: vec3f,
  transmissionDepth: f32,

  transmissionScatter: vec3f,
  transmissionScatterAnisotropy: f32,

  subsurfaceColor: vec3f,
  subsurfaceRadius: f32,

  fuzzColor: vec3f,
  fuzzRoughness: f32,

  coatColor: vec3f,
  coatWeight: f32,

  coatRoughness: f32,
  coatAnisotropy: f32,
  coatIor: f32,
  coatDarkening: f32,

  thinFilmWeight: f32,
  dispersionAbbeNumber: f32,
  subsurfaceScatterAnisotropy: f32,
  _padding5: f32,

  subsurfaceRadiusScale: vec3f,
  _padding6: f32,

  mediumExtinction: vec3f,
  mediumAnisotropy: f32,

  mediumScattering: vec3f,
  _padding7: f32,

  roughnessMapIndex: f32,
  metalnessMapIndex: f32,
  alphaMapIndex: f32,
  alphaCutoff: f32,

  bumpMapIndex: f32,
  bumpStrength: f32,
  doubleSided: f32,
  alphaMode: f32,
};

struct CameraUniform {
  viewProjectionInv: mat4x4<f32>,
  viewInv: mat4x4<f32>,
  aperture: f32,
  focusDistance: f32,
};

struct RayTraceUniform {
  outputSize: vec2f,
  sampleCount: f32,
  scaleOffset: vec4f,
  lightsCount: i32,
  transmissiveOutputAlphaMin: f32,
  jitter: vec2f,
  backgroundColor: vec4f,
  groundedBackgroundParams: vec4f,
  groundedBackgroundCenter: vec2f,
  blasOffset: i32,
  isEmpty: i32,
  previewMode: i32,
  previewBounces: i32,
  envLightPmf: f32,
  lightChoiceCount: i32,
  lightWeightTotal: f32,
  lightSamplingTextureWidth: i32,
  lightChoiceTexelOffset: i32,
  bounces: i32,
  varianceMoments: i32,
  adaptiveSampling: i32,
  clamping: f32,
  directLightCandidates: i32,
  backgroundFlags: i32,
  bsdfProposalCount: u32,
  sceneFeatureFlags: u32,
  sequenceSeed: u32,
  zSobolLogSPP: u32,
  sampleSequenceOffset: u32,
}

// Buffers
@group(0) @binding(0) var<storage, read> bvhBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read> instancesBuffer: array<vec4f>;
@group(0) @binding(2) var<storage, read> attrBuffers: array<vec3f>;
@group(0) @binding(3) var<storage, read> materialsBuffer: array<MaterialBuffer>;

// Textures
@group(1) @binding(0) var mapSampler: sampler;
@group(1) @binding(1) var map: texture_2d_array<f32>;
// The first NUM_MAPS entries contain atlas placement; the second half stores
// per-texture UV scale/offset; the third block stores the UV channel in x.
@group(1) @binding(3) var<uniform> mapInfo: array<vec4f, NUM_MAPS * 3>;
@group(1) @binding(4) var envMap: texture_2d<f32>;
@group(1) @binding(5) var envMapDistribution: texture_2d<f32>;
@group(1) @binding(6) var backgroundMap: texture_2d<f32>;
@group(1) @binding(8) var lightSamplingData: texture_2d<f32>;
@group(1) @binding(9) var openPbrEnergyLut: texture_2d<f32>;
@group(1) @binding(10) var adaptiveSampleTargets: texture_2d<f32>;

fn iesProfileScalar(baseTexel: i32, scalarIndex: i32) -> f32 {
  let texelIndex = baseTexel + scalarIndex / 4;
  let width = rtUniform.lightSamplingTextureWidth;
  let packed = textureLoad(lightSamplingData, vec2i(texelIndex % width, texelIndex / width), 0);
  return packed[scalarIndex % 4];
}

fn sampleIESProfile(baseTexel: i32, uv: vec2f) -> f32 {
  if (baseTexel < 0) { return 1.0; }
  let pixel = fract(uv) * 128.0 - vec2f(0.5);
  let x0 = i32(floor(pixel.x));
  let y0 = i32(floor(pixel.y));
  let fx = fract(pixel.x);
  let fy = fract(pixel.y);
  let xa = select(x0, 127, x0 < 0);
  let xb = select(x0 + 1, 0, x0 >= 127);
  let ya = select(y0, 127, y0 < 0);
  let yb = select(y0 + 1, 0, y0 >= 127);
  let a = iesProfileScalar(baseTexel, ya * 128 + xa);
  let b = iesProfileScalar(baseTexel, ya * 128 + xb);
  let c = iesProfileScalar(baseTexel, yb * 128 + xa);
  let d = iesProfileScalar(baseTexel, yb * 128 + xb);
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}

fn evaluateSpotEmissionMultiplier(light: Light, lightToSurface: vec3f) -> f32 {
  let axis = normalize(light.u);
  let cosTheta = dot(axis, lightToSurface);
  var cone = select(0.0, 1.0, cosTheta >= light.v.x);
  if (light.v.y > 1e-6) {
    cone = smoothstep(light.v.x, light.v.x + light.v.y, cosTheta);
  }
  if (cone <= 0.0 || light.textureIndex < 0.0) { return cone; }
  let signZ = select(-1.0, 1.0, axis.z >= 0.0);
  let a = -1.0 / (signZ + axis.z);
  let b = axis.x * axis.y * a;
  let xAxis = vec3f(1.0 + signZ * axis.x * axis.x * a, signZ * b, -signZ * axis.x);
  let yAxis = vec3f(b, signZ + axis.y * axis.y * a, -axis.y);
  let vertical = acos(clamp(cosTheta, -1.0, 1.0));
  let horizontal = atan2(dot(lightToSurface, yAxis), dot(lightToSurface, xAxis)) - light.v.z;
  return cone * sampleIESProfile(i32(light.textureIndex), vec2f(vertical / PI, horizontal / TWOPI + 0.5));
}

${
  hasDisplacement && USE_TFDM_DISPLACEMENT
    ? /*wgsl*/ `@group(1) @binding(7) var minmaxMap: texture_2d_array<f32>;`
    : ''
}
  
// Uniforms
@group(2) @binding(0) var<uniform> cameraUniform: CameraUniform;
@group(2) @binding(1) var<uniform> rtUniform: RayTraceUniform;

@group(2) @binding(2) var<uniform> analyticLights: array<Light, NUM_UNIFORM_LIGHTS>;
// TODO uniform must be aligned to 16 bytes.

fn initRay(ray: ptr<function, Ray>, origin: vec3f, direction: vec3f) {
  (*ray).o = origin;
  (*ray).d = direction;
}
`;
}
