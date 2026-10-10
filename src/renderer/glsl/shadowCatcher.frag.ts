// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import common from './chunks/common.glsl.js';
import rayTraceCore from './chunks/rayTraceCore.glsl.js';
import textureLinear from './chunks/textureLinear.glsl.js';
import materialBufferGlsl from './chunks/materialBuffer.glsl.js';
import intersect from './chunks/intersect.glsl.js';
import randGlsl from './chunks/rand.glsl.js';
import random from './chunks/random.glsl.js';
import envMap from './chunks/envMap.glsl.js';
import sampleShadowCatcher from './chunks/sampleShadowCatcher.glsl.js';
import sampleLight from './chunks/sampleLight.glsl.js';
import { FragmentShader, glsl, Shader } from '../shader.js';
import samplingGlsl from './chunks/sampling.glsl.js';
import uvProjectionGlsl from './chunks/uvProjection.glsl.js';

export default new FragmentShader({
  name: 'rayTarceFrag',
  defines: {
    BOUNCES: 2
  },
  uniforms: {
    viewProjectionInv: Shader.uniform('mat4')
  },
  includes: [rayTraceCore, materialBufferGlsl, intersect, random, envMap],
  main: glsl`
${common}
${randGlsl}
${random.main}

${textureLinear}

${rayTraceCore.main}
${uvProjectionGlsl}

${materialBufferGlsl.main}
${intersect.main}
${envMap.main}

${samplingGlsl}
${sampleLight}
${sampleShadowCatcher}

// Path tracing integrator as described in
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Path_Tracing.html#
vec4 integrator(inout Ray ray) {
  Path path;
  path.ray = ray;
  path.li = vec3(0);
  path.alpha = 1.0;
  path.beta = vec3(1.0);
  path.fromEye = true;
  path.scatteringPdf = 0.0;
  path.abort = false;

  SurfaceInteraction si;

  intersectScene(path.ray, si, false);
  if (!si.hit) {
    // Red stores catcher coverage. Keep it zero for pixels where the primary
    // ray did not hit the catcher so denoised shadows cannot bleed onto the
    // model silhouette during composition.
    return vec4(0.0, 0.0, 0.0, 1.0);
  }

  OpenPbrResolvedMaterial mat;
  getMaterial(mat, si.materialIndex, si.uv, si.uv1);
  if (mat.materialType != SHADOW_CATCHER) {
    // The main path tracer already renders regular geometry. Only evaluate
    // shadow opacity when the primary ray actually hits the catcher.
    return vec4(0.0, 0.0, 0.0, 1.0);
  }

  if (!path.abort) {
    sampleShadowCatcher(si, 0, path);
  }
  return vec4(vec3(1.0), path.alpha);
}

void main() {
  initRandom();
  rng_initialize(v_Texcoord / pixelSize, int(sampleCount));


  vec2 uvJittered = v_Texcoord + pixelJitter();

  vec4 origin = viewProjectionInv * vec4(uvJittered * 2.0 - 1.0, -1.0, 1.0);
  vec4 target = viewProjectionInv * vec4(uvJittered * 2.0 - 1.0, 1.0, 1.0);

  Ray cam;
  initRay(cam, origin.xyz / origin.w, normalize(target.xyz * origin.w - origin.xyz * target.w));

  vec4 liAndAlpha = integrator(cam);

  if (!(liAndAlpha.x < INF && liAndAlpha.x > -EPS)) {
    liAndAlpha = vec4(0, 0, 0, 1);
  }

  out_color = liAndAlpha;

}`
});
