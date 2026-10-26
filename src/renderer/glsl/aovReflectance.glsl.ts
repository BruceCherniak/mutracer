// GLSL mirror of the shared 256-proposal, fused OpenPBR reflection quadrature.
export default /* glsl */ `
void aovReflectance(OpenPbrPreparedBsdf prepared, bool wantDiffuse, bool wantSpecular, out vec3 diffuse, out vec3 specular) {
  diffuse=vec3(0.0); specular=vec3(0.0);
  vec3 view = prepared.viewLocal;
  if (view.z <= 1e-6) { return; }
  OpenPbrResolvedMaterial material = prepared.material;
  vec2 alpha = vec2(material.alphaX, material.alphaY);
  float viewMasking = sampling_ggx_smith_g1(view, alpha);
  float diffuseWeight = prepared.weights[OPENPBR_LOBE_DIFFUSE];
  float metalWeight = prepared.weights[OPENPBR_LOBE_METAL];
  float specularWeight = prepared.weights[OPENPBR_LOBE_SPECULAR];
  float dielectricAverageLoss = 1.0;
  if (wantSpecular && prepared.dielectricMsProbability > 0.0) {
    dielectricAverageLoss = max(openpbr_ideal_dielectric_average_loss(prepared.refractionEtaTOverEtaI, prepared.specularAlpha), 1e-12);
  }
  uint count = 256u;
  for (uint i = 0u; i < uint(NO_UNROLL(256)); i++) {
    uint pair = i / 2u;
    vec2 u = vec2((float(pair) + 0.5) / float(count / 2u),
      fract(float(reverseBits(pair)) * 2.3283064365386963e-10 + 0.37));
    vec3 light = sampling_cosine_hemisphere(u);
    if ((i & 1u) != 0u) {
      vec3 halfVector = sampling_ggx_visible_normal(view, alpha, u);
      light = reflect(-view, halfVector);
    }
    // Rejected VNDF proposals retain their weight in the denominator.
    if (light.z <= 0.0) { continue; }
    vec3 halfVector = normalize(view + light);
    float specularPdf = viewMasking * sampling_ggx_ndf(halfVector, alpha) / (4.0 * view.z);
    float pdf = 0.5 * (light.z * INVPI + specularPdf);
    // Preserve the production evaluator's frame round trip, including FP32
    // rounding near narrow highlights. Proposal PDFs use the original light.
    vec3 evaluatedLight = openpbr_to_local(prepared.basis, openpbr_to_world(prepared.basis, light));
    if (evaluatedLight.z <= 0.0) { continue; }
    float scale = abs(evaluatedLight.z) / (pdf * float(count));
    if (wantDiffuse && diffuseWeight > 0.0) {
      float compensation = prepared.diffuseSpecularEnergyCompensation * openpbr_opaque_energy_complement(
        prepared.specularEtaTOverEtaI, prepared.specularAlpha, abs(evaluatedLight.z));
      float unusedPdf = 0.0;
      diffuse += diffuseWeight * openpbr_eval_diffuse(material, prepared.diffuseColor,
        view, evaluatedLight, compensation, unusedPdf) * scale;
    }
    if (wantSpecular) {
      vec3 evaluatedHalf = normalize(view + evaluatedLight);
      float viewHalf = abs(dot(view, evaluatedHalf));
      vec3 fresnel = vec3(0.0);
      if (specularWeight > 0.0) {
        vec3 dielectric = vec3(openpbr_dielectric_fresnel(viewHalf, material.relativeIor));
        if (material.thinWalled) { dielectric = openpbr_thin_wall_reflection_coefficient(dielectric, material.transmissionWeight); }
        fresnel += specularWeight * material.specularColor * dielectric;
      }
      if (metalWeight > 0.0) {
        fresnel += metalWeight * material.specularWeight * openpbr_metal_fresnel(viewHalf,
          material.baseWeight * material.baseColor, material.specularColor);
      }
      float microfacet = sampling_ggx_ndf(evaluatedHalf, alpha) * viewMasking
        * sampling_ggx_smith_g1(evaluatedLight, alpha) / (4.0 * max(evaluatedLight.z * view.z, 1e-8));
      vec3 reflection = fresnel * microfacet;
      if (metalWeight > 0.0 && prepared.metalMsFactor > 0.0) {
        float factor = min(prepared.metalMsFactor * openpbr_metal_energy_complement(prepared.specularAlpha, evaluatedLight.z), 1.0 / max(evaluatedLight.z, 1e-8));
        reflection += metalWeight * prepared.metalMsScale * factor * INVPI;
      }
      if (prepared.dielectricMsProbability > 0.0) {
        float factors = prepared.dielectricMsViewLoss * openpbr_ideal_dielectric_loss(
          prepared.refractionEtaTOverEtaI, prepared.specularAlpha, abs(evaluatedLight.z)) / dielectricAverageLoss;
        float factor = min(factors * prepared.dielectricMsReflectionRatio, 1.0 / abs(evaluatedLight.z));
        reflection += prepared.dielectricMsReflectionScale * factor * INVPI;
      }
      specular += reflection * scale;
    }
  }
  return;
}
`;
