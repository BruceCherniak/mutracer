struct Params { size: vec2u, premultiply: u32, flags: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> color: array<vec4f>;
@group(0) @binding(2) var output: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let value = color[id.y * params.size.x + id.x];
  let alpha = select(1.0, clamp(value.a, 0.0, 1.0), (params.flags & 1u) != 0u);
  var rgb = max(value.rgb, vec3f(0.0));
  if (params.premultiply != 0u) { rgb *= alpha; }
  textureStore(output, id.xy, vec4f(rgb, alpha));
}
