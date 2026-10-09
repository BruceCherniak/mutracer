// Estimate the direct lighting integral using multiple importance sampling
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Direct_Lighting.html#EstimatingtheDirectLightingIntegral

export default /*wgsl*/ `

fn sampleShadowCatcher(si: SurfaceInteraction, bounce: i32, path: ptr<function, Path>) {
  let viewDir = -(*path).ray.d;

  // The unified table also contains emissive mesh lights.
  if (rtUniform.lightChoiceCount > 0) {
    var lightSample: LightSampleRec;
    let lightRnd = vec3f(sample2D(bounceDim(LIGHT_POSITION)), sample1D(bounceDim(LIGHT_SELECT)));
    sampleLight(si.position, lightRnd, &lightSample, false);
    let lightDir = lightSample.direction;
    var shadow = 0.0;
    let cosThetaL = dot(si.normal, lightDir);
    let orientation = dot(si.normal, viewDir) * cosThetaL;
    if (lightSample.pdf > 0.0 && orientation >= 0.0) {
      var ray: Ray;
      initRay(&ray, si.position + EPS * lightDir, lightDir);
      if (intersectSceneShadow(ray, lightSample.dist - EPS, si.triangleIndex)) {
        shadow = 1.0;
      }
    }
    // WebGPU's compose pass consumes shadow opacity directly.
    (*path).alpha = shadow;
  }
  (*path).fromEye = false;
}
`;
