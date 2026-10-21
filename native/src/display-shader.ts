// Native presentation reuses the Web display functions without changing Web code.
import {composeDefine} from '../../src/renderer/wgsl/compose.frag.wgsl.ts';
export function nativeDisplayShader(): string {
  return `
struct Params {
  size: vec2u, samples: f32, exposure: f32,
  toneMode: u32, outputKind: u32, flags: u32, originalSamples: f32,
  grading: vec4f
}
@group(0) @binding(0) var<storage, read> accumulation: array<vec4f>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read> normals: array<vec4f>;
@group(0) @binding(4) var<storage, read> albedos: array<vec4f>;

var<private> toneMappingParams: vec4f;
var<private> colorGradingParams: vec4f;
${composeDefine}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  toneMappingParams = vec4f(f32(params.toneMode), 0.0, 0.0, 0.0);
  colorGradingParams = params.grading;
  let index = (params.size.y - 1u - id.y) * params.size.x + id.x;
  let rgba = accumulation[index] / params.samples;
  var alpha = select(1.0, clamp(rgba.a, 0.0, 1.0), (params.flags & 1u) != 0u);
  var linear = rgba.rgb;
  // Raw radiance is accumulated by sample count. Transparent edge colors use
  // the hit count, matching the shared Web normalization before tone mapping.
  let hit = albedos[index].a / params.originalSamples;
  if (alpha < 1.0 && hit > 0.0) { linear /= hit; }
  var color = linearToSrgb(applyToneMapping(gradeColor(max(linear * params.exposure, vec3f(0.0)))));
  if (params.outputKind == 1u) {
    let normal = normals[index];
    alpha = select(0.0, 1.0, dot(normal.rgb, normal.rgb) > 0.1);
    color = select(vec3f(0.0), normal.rgb / params.originalSamples * 0.5 + 0.5, alpha > 0.0);
  } else if (params.outputKind == 2u) {
    let albedo = albedos[index] / params.originalSamples;
    color = linearToSrgb(albedo.rgb);
    alpha = clamp(albedo.a, 0.0, 1.0);
  }
  if ((params.flags & 2u) != 0u) { color *= alpha; }
  textureStore(output, id.xy, vec4f(color, alpha));
}`;
}
