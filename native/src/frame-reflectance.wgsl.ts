// Deterministic directional-hemispherical quadrature for the initial FP32 input
// baseline. It evaluates the production BSDF, including its lobe weights and
// energy compensation, without touching the path tracer's random stream.
// This deliberately expensive opt-in baseline precedes LUT/performance work.
export default /* wgsl */ `
struct MtReflectance {
  diffuse: vec3f,
  specular: vec3f,
}
fn mtFrameReflectance(prepared: OpenPbrPreparedBsdf) -> MtReflectance {
  var result = MtReflectance();
  let view = prepared.viewLocal;
  if (view.z <= 1e-6) { return result; }
  let alpha = vec2f(prepared.material.alphaX, prepared.material.alphaY);
  // Balanced cosine/VNDF proposals cover diffuse, smooth reflection and the
  // broad multiple-scattering tails. Rejected VNDF proposals contribute zero;
  // they must not be removed from the denominator.
  let count = 256u * min(rtUniform.loopUnrollGuard, 4u) / 4u;
  for (var i = 0u; i < count; i++) {
    let pair = i / 2u;
    let u = vec2f((f32(pair) + 0.5) / f32(count / 2u),
      fract(f32(reverseBits(pair)) * 2.3283064365386963e-10 + 0.37));
    var light = sampling_cosine_hemisphere(u);
    if ((i & 1u) != 0u) {
      let half = sampling_ggx_visible_normal(view, alpha, u);
      light = reflect(-view, half);
    }
    if (light.z <= 0.0) { continue; }
    let half = normalize(view + light);
    let specularPdf = sampling_ggx_smith_g1(view, alpha)
      * sampling_ggx_ndf(half, alpha) / (4.0 * view.z);
    let pdf = 0.5 * (light.z * INVPI + specularPdf);
    let direction = openpbr_to_world(prepared.basis, light);
    var values: array<vec3f, 2>;
    // Keep a single evaluation call site instead of duplicating the optical
    // graph. This loop is dynamic to avoid driver unrolling of that graph.
    for (var layer = 0u; layer < min(2u, rtUniform.loopUnrollGuard); layer++) {
      var unusedPdf = 0.0;
      let lobe = select(OPENPBR_LOBE_DIFFUSE, -1, layer == 1u);
      values[layer] = openpbr_eval_prepared_lobe(prepared, direction, lobe, &unusedPdf);
    }
    // The production evaluator already returns BSDF * abs(N dot L).
    let scale = 1.0 / (pdf * f32(count));
    result.diffuse += values[0] * scale;
    // All reflection, including conductor/dielectric multiple scattering.
    result.specular += (values[1] - values[0]) * scale;
  }
  return result;
}
`;
