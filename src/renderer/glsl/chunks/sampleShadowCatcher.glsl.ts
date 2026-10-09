// Estimate the direct lighting integral using multiple importance sampling
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Direct_Lighting.html#EstimatingtheDirectLightingIntegral

import { glsl } from '../../shader';

export default glsl`
// A one-sample binary shadow test leaves scattered fully dark pixels far
// from the occluder at low sample counts. Averaging a few light samples per
// primary hit costs only shadow rays and lets the mask settle much sooner.
// Candidate dimensions match WGSL lightDim().
const uint SHADOW_CATCHER_LIGHT_SAMPLES = 4u;

uint shadowCatcherLightDim(uint candidate, uint slot) {
  return candidate == 0u ? bounceDim(slot) : bounceDim(9u + (candidate - 1u) * 3u + slot);
}

void sampleShadowCatcher(SurfaceInteraction si, int bounce, inout Path path) {
  vec3 viewDir = -path.ray.d;

#if defined(NUM_LIGHTS) || defined(USE_ENVMAP)
  float visibility = 0.0;
  for (uint candidate = 0u; candidate < SHADOW_CATCHER_LIGHT_SAMPLES; candidate++) {
    LightSampleRec lightSample;
    vec3 lightRnd = vec3(
      sample2D(shadowCatcherLightDim(candidate, LIGHT_POSITION)),
      sample1D(shadowCatcherLightDim(candidate, LIGHT_SELECT))
    );
    sampleLight(si.position, lightRnd, lightSample, false);

    vec3 lightDir = lightSample.direction;
    float cosThetaL = dot(si.normal, lightDir);
    float orientation = dot(si.normal, viewDir) * cosThetaL;
    bool occluded = false;
    if (orientation >= 0.0) {
      Ray ray;
      initRay(ray, si.position + EPS * lightDir, lightDir);
      occluded = intersectSceneShadow(ray, lightSample.dist - EPS, si.triangleIndex);
    }
    visibility += occluded ? 0.0 : 1.0;
  }
  // WebGL's compose pass converts visibility to shadow opacity.
  path.alpha = visibility / float(SHADOW_CATCHER_LIGHT_SAMPLES);
#endif
  path.fromEye = false;
}
`;
