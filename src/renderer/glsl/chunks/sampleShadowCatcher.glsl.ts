// Estimate the direct lighting integral using multiple importance sampling
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Direct_Lighting.html#EstimatingtheDirectLightingIntegral

import { glsl } from '../../shader';

export default glsl`
void sampleShadowCatcher(SurfaceInteraction si, int bounce, inout Path path) {
  vec3 viewDir = -path.ray.d;

#if defined(NUM_LIGHTS) || defined(USE_ENVMAP)
  LightSampleRec lightSample;
  vec3 lightRnd = vec3(randomSample(), randomSample(), randomSample());
  sampleLight(si.position, lightRnd, lightSample, false);

  vec3 lightDir = lightSample.direction;
  float visibility = 1.0;
  float cosThetaL = dot(si.normal, lightDir);
  float orientation = dot(si.normal, viewDir) * cosThetaL;
  if (orientation >= 0.0) {
    Ray ray;
    initRay(ray, si.position + EPS * lightDir, lightDir);
    if (intersectSceneShadow(ray, lightSample.dist - EPS, si.triangleIndex)) {
      visibility = 0.0;
    }
  }
  // WebGL's compose pass converts visibility to shadow opacity.
  path.alpha = visibility;
#endif
  path.fromEye = false;
}
`;
