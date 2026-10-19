// Native presentation reuses the Web display functions without changing Web code.
import {composeDefine} from '../src/renderer/wgsl/compose.frag.wgsl.ts';
export function nativeDisplayShader(): string {
  return `
struct Params { size: vec2u, samples: f32, exposure: f32 }
@group(0) @binding(0) var<storage, read> accumulation: array<vec4f>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;
const toneMappingParams = vec4f(3.0, 0.0, 0.0, 0.0);
const colorGradingParams = vec4f(1.0, 1.0, 0.0, 0.0);
${composeDefine}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let index = (params.size.y - 1u - id.y) * params.size.x + id.x;
  let linear = accumulation[index].rgb / params.samples * exp2(params.exposure);
  textureStore(output, id.xy, vec4f(linearToSrgb(applyToneMapping(max(linear,vec3f(0.0)))), 1.0));
}`;
}
