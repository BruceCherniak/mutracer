import { FragmentShader, glsl, Shader } from '../shader.js';

/**
 * Normalize
 */
const normalizeRayTraceOutput = new FragmentShader({
  name: 'normalizeRayTraceOutput',
  outputs: ['color', 'albedo', 'normal', 'shadowCatcher'],

  uniforms: {
    colorTex: Shader.uniform('sampler2D'),
    albedoTex: Shader.uniform('sampler2D'),
    normalTex: Shader.uniform('sampler2D'),
    shadowCatcherTex: Shader.uniform('sampler2D'),

    sampleCount: Shader.uniform('float', 1),
    lightScale: Shader.uniform('vec2', [1, 1])
  },

  main: glsl`
void main() {
  vec2 uv = lightScale * v_Texcoord;
  vec4 albedoTexel = texture(albedoTex, uv);
  float hit = albedoTexel.a;
  vec4 normalTexel = texture(normalTex, uv);
  // Spectral WebGL rendering submits three additive wavelength passes per
  // sample. Normalize auxiliary guides by their actual contribution count,
  // not the logical sample count, or they saturate before denoising.
  float guideCount = max(normalTexel.a, 1.0);
  vec3 albedo = albedoTexel.rgb / guideCount;
  vec3 normal = normalTexel.rgb / guideCount;
  vec4 shadowCatcher= texture(shadowCatcherTex, uv) / sampleCount;
  vec4 lightTexel = texture(colorTex, uv);
  // vec2 hit = texture(hitTex, uv).rg;
  // average the color by hit count.
  // So the antialised edge color will be correct when having transparent background
  // TODO In some platforms. the output of hit.r is always 0. In this case we use sampleCount instead.
  vec4 light = vec4(lightTexel.rgb / (hit > 0.0 ? hit : sampleCount), lightTexel.a / sampleCount);

  // Pixels whose primary rays mostly miss geometry have no normal (alpha 0),
  // as in the WebGPU output.
  out_normal = dot(normal, normal) > 0.1 ? vec4(normal * 0.5 + 0.5, 1.0) : vec4(0.0);
  out_albedo = vec4(albedo, 1.0);
  out_shadowCatcher = shadowCatcher;
  out_color = light;
}
  `
});

export default normalizeRayTraceOutput;
