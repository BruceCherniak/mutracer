// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

// Sample the environment map using a cumulative distribution function as described in
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Sampling_Light_Sources.html#InfiniteAreaLights

import { createShaderMixin, glsl, Shader } from '../../shader.js';

export default createShaderMixin({
  uniforms: {
    environmentRotation: Shader.uniform('mat3', [1,0,0, 0,1,0, 0,0,1]),
    envMap: Shader.uniform('sampler2D'),
    envMapDistribution: Shader.uniform('sampler2D'),
    backgroundMap: Shader.uniform('sampler2D'),
    groundedBackgroundParams: Shader.uniform('vec4'),
    groundedBackgroundCenter: Shader.uniform('vec2')
  },
  main: glsl`
vec2 cartesianToEquirect(vec3 pointOnSphere) {
  float phi = mod(atan(-pointOnSphere.z, -pointOnSphere.x), TWOPI);
  float theta = acos(clamp(pointOnSphere.y, -1.0, 1.0));
  return vec2(phi * 0.5 * INVPI, theta * INVPI);
}

vec2 environmentUv(vec3 worldDirection) {
  return cartesianToEquirect(transpose(environmentRotation) * worldDirection);
}

float getEnvmapV(float u, out int vOffset, out float pdf) {
  ivec2 size = textureSize(envMap, 0);

  int left = 0;
  int right = size.y + 1; // cdf length is the length of the env map + 1
  while (left < right) {
    int mid = (left + right) >> 1;
    float s = texelFetch(envMapDistribution, ivec2(0, mid), 0).x;
    if (s <= u) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  vOffset = left - 1;

  // x channel is cumulative distribution of env map luminance
  // y channel is partial probability density of env map luminance
  vec2 s0 = texelFetch(envMapDistribution, ivec2(0, vOffset), 0).xy;
  vec2 s1 = texelFetch(envMapDistribution, ivec2(0, vOffset + 1), 0).xy;

  pdf = s0.y;

  return (float(vOffset) +  (u - s0.x) / (s1.x - s0.x)) / float(size.y);
}

float getEnvmapU(float u, int vOffset, out float pdf) {
  ivec2 size = textureSize(envMap, 0);

  int left = 0;
  int right = size.x + 1; // cdf length is the length of the env map + 1
  while (left < right) {
    int mid = (left + right) >> 1;
    float s = texelFetch(envMapDistribution, ivec2(1 + mid, vOffset), 0).x;
    if (s <= u) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  int uOffset = left - 1;

  // x channel is cumulative distribution of env map luminance
  // y channel is partial probability density of env map luminance
  vec2 s0 = texelFetch(envMapDistribution, ivec2(1 + uOffset, vOffset), 0).xy;
  vec2 s1 = texelFetch(envMapDistribution, ivec2(1 + uOffset + 1, vOffset), 0).xy;

  pdf = s0.y;

  return (float(uOffset) + (u - s0.x) / (s1.x - s0.x)) / float(size.x);
}

// Perform two binary searches to find light direction.
vec3 sampleEnvmap(vec2 random, out vec2 uv, out float pdf) {
  vec2 partialPdf;
  int vOffset;

  uv.y = getEnvmapV(random.x, vOffset, partialPdf.y);
  uv.x = getEnvmapU(random.y, vOffset, partialPdf.x);

  float phi = uv.x * TWOPI;
  float theta = uv.y * PI;
  float cosTheta = cos(theta);
  float sinTheta = sin(theta);
  float cosPhi = cos(phi);
  float sinPhi = sin(phi);

  vec3 dir = vec3(-sinTheta * cosPhi, cosTheta, -sinTheta * sinPhi);

  pdf = partialPdf.x * partialPdf.y * INVPI2 / (2.0 * sinTheta);

  return environmentRotation * dir;
}

float envMapPdf(vec2 uv) {
  vec2 size = vec2(textureSize(envMap, 0));

  float sinTheta = sin(uv.y * PI);

  uv *= size;

  float partialX = texelFetch(envMapDistribution, ivec2(1.0 + uv.x, uv.y), 0).y;
  float partialY = texelFetch(envMapDistribution, ivec2(0, uv.y), 0).y;

  return partialX * partialY * INVPI2 / (2.0 * sinTheta);
}

float groundedSurfaceDistance(vec3 point, float height, float radius) {
  float pointLength = length(point);
  if (pointLength < 0.00001) {
    return -radius;
  }

  float originalY = radius * point.y / pointLength;
  float transitionY = -1.5 * height;
  float surfaceRadius;
  if (originalY >= 0.0) {
    surfaceRadius = radius;
  } else if (originalY < transitionY) {
    surfaceRadius = -height * pointLength / point.y;
  } else {
    float factor = 1.0
      - originalY * originalY / (3.0 * transitionY * transitionY);
    surfaceRadius = radius * factor;
  }
  return pointLength - surfaceRadius;
}

vec3 groundedBackgroundDirection(vec3 origin, vec3 d) {
#ifdef USE_GROUNDED_BACKGROUND
  float height = groundedBackgroundParams.x;
  float radius = groundedBackgroundParams.y;
  float groundY = groundedBackgroundParams.z;
  vec3 rayDirection = normalize(d);
  vec3 localOrigin = origin - vec3(
    groundedBackgroundCenter.x,
    groundY + height,
    groundedBackgroundCenter.y
  );

  // The grounded skybox is a deformed sphere. Find the point where the ray
  // exits that surface so its texture lookup matches the rasterized geometry.
  float projectedOrigin = dot(localOrigin, rayDirection);
  float discriminant = projectedOrigin * projectedOrigin
    - dot(localOrigin, localOrigin) + radius * radius;
  if (discriminant > 0.0) {
    float farDistance = -projectedOrigin + sqrt(discriminant);
    if (
      farDistance > 0.0
      && groundedSurfaceDistance(localOrigin, height, radius) <= 0.0
    ) {
      vec3 sphereHit = localOrigin + rayDirection * farDistance;
      if (sphereHit.y >= 0.0) {
        return normalize(sphereHit);
      }

      if (rayDirection.y < -0.00001 && radius > 1.5 * height) {
        float groundDistance = (-height - localOrigin.y) / rayDirection.y;
        vec3 groundHit = localOrigin + rayDirection * groundDistance;
        float groundRadius = (2.0 / 3.0)
          * sqrt(radius * radius - 2.25 * height * height);
        if (groundDistance > 0.0 && length(groundHit.xz) <= groundRadius) {
          return normalize(groundHit);
        }
      }

      float nearDistance = 0.0;
      for (int i = 0; i < 14; i++) {
        float middleDistance = (nearDistance + farDistance) * 0.5;
        vec3 middlePoint = localOrigin + rayDirection * middleDistance;
        if (groundedSurfaceDistance(middlePoint, height, radius) > 0.0) {
          farDistance = middleDistance;
        } else {
          nearDistance = middleDistance;
        }
      }
      vec3 hit = localOrigin + rayDirection * ((nearDistance + farDistance) * 0.5);
      return normalize(hit);
    }
  }
#endif
  return d;
}

vec4 sampleBackgroundFromRay(vec3 origin, vec3 d) {
  d = groundedBackgroundDirection(origin, d);
#ifdef USE_BACKGROUND
  vec2 uv = cartesianToEquirect(d);
#else
  vec2 uv = environmentUv(d);
#endif
  return textureLinear(backgroundMap, uv);
}`
});
