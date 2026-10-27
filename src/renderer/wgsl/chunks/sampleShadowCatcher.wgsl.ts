// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

// Estimate the direct lighting integral using multiple importance sampling
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Direct_Lighting.html#EstimatingtheDirectLightingIntegral

export default /*wgsl*/ `

// A one-sample binary shadow test leaves scattered fully dark pixels far
// from the occluder at low sample counts. Averaging a few light samples per
// primary hit costs only shadow rays and lets the mask settle much sooner.
const SHADOW_CATCHER_LIGHT_SAMPLES = 4u;

fn sampleShadowCatcher(si: SurfaceInteraction, bounce: i32, path: ptr<function, Path>) {
  let viewDir = -(*path).ray.d;

  // The catcher table holds only the environment and analytic lights, as in
  // WebGL 2: emissive meshes are scene objects, not light in the plate.
  if (rtUniform.shadowCatcherChoiceCount > 0) {
    var shadow = 0.0;
    for (var candidate = 0u; candidate < SHADOW_CATCHER_LIGHT_SAMPLES; candidate++) {
      var lightSample: LightSampleRec;
      let lightRnd = vec3f(sample2D(lightDim(candidate, 1u)), sample1D(lightDim(candidate, 0u)));
      sampleLightChoiceTable(
        si.position,
        lightRnd,
        rtUniform.shadowCatcherChoiceOffset,
        rtUniform.shadowCatcherChoiceCount,
        1.0,
        &lightSample
      );
      let lightDir = lightSample.direction;
      let cosThetaL = dot(si.normal, lightDir);
      let orientation = dot(si.normal, viewDir) * cosThetaL;
      if (lightSample.pdf > 0.0 && orientation >= 0.0) {
        var ray: Ray;
        initRay(&ray, si.position + EPS * lightDir, lightDir);
        if (intersectSceneShadow(ray, lightSample.dist - EPS, si.triangleIndex)) {
          shadow += 1.0;
        }
      }
    }
    // WebGPU's compose pass consumes shadow opacity directly.
    (*path).alpha = shadow / f32(SHADOW_CATCHER_LIGHT_SAMPLES);
  }
  (*path).fromEye = false;
}
`;
