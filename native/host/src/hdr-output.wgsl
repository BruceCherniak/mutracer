// Same color/coverage resolve as createNormalizeRayTraceOutputWGSL in
// src/renderer/WGPURayTraceOutput.ts; native traces complete whole-frame samples.
@group(0) @binding(0) var<storage, read> color: array<vec4f>;
@group(0) @binding(1) var<storage, read> normal: array<vec4f>;
@group(0) @binding(2) var<storage, read> albedo: array<vec4f>;
@group(0) @binding(3) var output: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (any(id.xy >= size)) { return; }
    let i = (size.y - 1u - id.y) * size.x + id.x;
    var rgba = vec4f(0.0);
    if (normal[i].a > 0.0) {
        let total = max(normal[i].a, 1.0);
        let hit = albedo[i].a;
        rgba = vec4f(color[i].rgb / select(total, hit, hit > 0.0), color[i].a / total);
    }
    textureStore(output, id.xy, rgba);
}
