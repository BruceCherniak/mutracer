// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

// Sample the environment map using a cumulative distribution function as described in
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Sampling_Light_Sources.html#InfiniteAreaLights

export default /* wgsl */ `

fn textureLinear(tex: texture_2d<f32>, _uv: vec2f) -> vec4f {
  // #ifdef OES_texture_float_linear
  //   return texture(map, uv);
  // #else
  let size = vec2f(textureDimensions(tex, 0));

  let uv2f = _uv * size - vec2f(0.5);
  let uvFloor = floor(uv2f);
  let f = fract(uv2f);
  let uv2i = vec2i(uvFloor);
  let maximum = vec2i(size) - vec2i(1);

  // TODO use textureGather
  let s1 = textureLoad(tex, clamp(uv2i + vec2i(0, 0), vec2i(0), maximum), 0);
  let s2 = textureLoad(tex, clamp(uv2i + vec2i(1, 0), vec2i(0), maximum), 0);
  let s3 = textureLoad(tex, clamp(uv2i + vec2i(0, 1), vec2i(0), maximum), 0);
  let s4 = textureLoad(tex, clamp(uv2i + vec2i(1, 1), vec2i(0), maximum), 0);

  return mix(mix(s1, s2, f.x), mix(s3, s4, f.x), f.y);
  // #endif
}

fn cartesianToEquirect(pointOnSphere: vec3f) -> vec2f {
  var phi = atan2(-pointOnSphere.z, -pointOnSphere.x);
  if (phi < 0.0) {
    phi += TWOPI;
  }
  let theta = acos(clamp(pointOnSphere.y, -1.0, 1.0));
  return vec2f(phi * 0.5 * INVPI, theta * INVPI);
}

fn environmentOrientation() -> mat3x3f {
  return mat3x3f(rtUniform.environmentRotation[0].xyz, rtUniform.environmentRotation[1].xyz, rtUniform.environmentRotation[2].xyz);
}

fn environmentUv(worldDirection: vec3f) -> vec2f {
  return cartesianToEquirect(transpose(environmentOrientation()) * worldDirection);
}

fn getEnvmapV(u: f32, vOffset: ptr<function, i32>, pdf: ptr<function, vec2f>) -> f32 {
  let size = vec2i(textureDimensions(envMap, 0));

  var left = 0;
  var right = size.y + 1; // cdf length is the length of the env map + 1
  while (left < right) {
    let mid = (left + right) >> 1;
    let s = textureLoad(envMapDistribution, vec2i(0, mid), 0).x;
    if (s <= u) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  *vOffset = left - 1;

  // x channel is cumulative distribution of env map luminance
  // y channel is partial probability density of env map luminance
  let s0 = textureLoad(envMapDistribution, vec2i(0, *vOffset), 0).xy;
  let s1 = textureLoad(envMapDistribution, vec2i(0, *vOffset + 1), 0).xy;

  (*pdf).y = s0.y;

  return (f32(*vOffset) +  (u - s0.x) / (s1.x - s0.x)) / f32(size.y);
}

fn getEnvmapU(u: f32, vOffset: i32, pdf: ptr<function, vec2f>) -> f32 {
  let size = vec2i(textureDimensions(envMap, 0));

  var left = 0;
  var right = size.x + 1; // cdf length is the length of the env map + 1
  while (left < right) {
    let mid = (left + right) >> 1;
    let s = textureLoad(envMapDistribution, vec2i(1 + mid, vOffset), 0).x;
    if (s <= u) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  let uOffset = left - 1;

  // x channel is cumulative distribution of env map luminance
  // y channel is partial probability density of env map luminance
  let s0 = textureLoad(envMapDistribution, vec2i(1 + uOffset, vOffset), 0).xy;
  let s1 = textureLoad(envMapDistribution, vec2i(1 + uOffset + 1, vOffset), 0).xy;

  (*pdf).x = s0.y;

  return (f32(uOffset) + (u - s0.x) / (s1.x - s0.x)) / f32(size.x);
}

// The lat-long Jacobian is undefined at either pole. In f32, sin(PI) can
// also be negative, which makes MIS amplify a BSDF hit instead of weighting it.
fn envMapSolidAnglePdf(partialPdf: vec2f, v: f32) -> f32 {
  if (!(v > 0.0 && v < 1.0)) { return 0.0; }
  let sinTheta = sin(min(v, 1.0 - v) * PI);
  return partialPdf.x * partialPdf.y * INVPI2 / (2.0 * sinTheta);
}

// Perform two binary searches to find light direction.
fn sampleEnvmap(random: vec2f, uv: ptr<function, vec2f>, pdf: ptr<function, f32>) -> vec3f {
  var partialPdf: vec2f;
  var vOffset: i32;

  (*uv).y = getEnvmapV(random.x, &vOffset, &partialPdf);
  (*uv).x = getEnvmapU(random.y, vOffset, &partialPdf);

  let phi = (*uv).x * TWOPI;
  let theta = (*uv).y * PI;
  let cosTheta = cos(theta);
  let sinTheta = sin(theta);
  let cosPhi = cos(phi);
  let sinPhi = sin(phi);

  let dir = vec3f(-sinTheta * cosPhi, cosTheta, -sinTheta * sinPhi);

  *pdf = envMapSolidAnglePdf(partialPdf, (*uv).y);

  return environmentOrientation() * dir;
}

fn envMapPdf(_uv: vec2f) -> f32 {
  let size = vec2f(textureDimensions(envMap, 0));

  let _uv2 = clamp(vec2i(_uv * size), vec2i(0), vec2i(size) - vec2i(1));

  let partialX = textureLoad(envMapDistribution, vec2i(1 + _uv2.x, _uv2.y), 0).y;
  let partialY = textureLoad(envMapDistribution, vec2i(0, _uv2.y), 0).y;

  return envMapSolidAnglePdf(vec2f(partialX, partialY), _uv.y);
}


`;
