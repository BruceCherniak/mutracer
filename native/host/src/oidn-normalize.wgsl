// CPU reference: hdr::resolve. Keep the division order of MT_IMAGE_HDR readback,
// including its per-sample f32 rounding, flat-background misses and path alpha.
struct Params { size: vec2u, samples: u32, flat: u32 }
@group(0) @binding(0) var<storage, read> color: array<vec4f>;
@group(0) @binding(1) var<storage, read> albedo: array<vec4f>;
@group(0) @binding(2) var<storage, read> normal: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> resolved: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> preview: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> guide: array<vec4f>;
@group(0) @binding(6) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn normalize(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= params.size)) { return; }
    let i = id.y * params.size.x + id.x;
    let samples = f32(params.samples);
    let col = color[i] / samples;
    let nor = normal[i] / samples;
    let alb = albedo[i] / samples;
    var result = vec4f(0.0);
    if (nor.a > 0.0) {
        let total = max(nor.a, 1.0 / samples);
        let divisor = select(total, alb.a, alb.a > 0.0);
        result = vec4f(col.rgb / divisor, col.a / total);
        let coverage = clamp(alb.a / total, 0.0, 1.0);
        if (params.flat != 0u && coverage > 0.0) {
            result = vec4f(result.rgb * coverage, result.a);
        }
    }
    resolved[i] = result;
    preview[i] = alb;
    guide[i] = nor;
}

// Separate entry point: the planner's output is resolved HDR. Undo only its
// coverage resolve for the existing display composition, leaving readback intact.
@group(0) @binding(3) var<storage, read> filtered: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> displayColor: array<vec4f>;
@group(0) @binding(5) var<uniform> displayParams: Params;
@compute @workgroup_size(8, 8)
fn restore(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= displayParams.size)) { return; }
    let i = id.y * displayParams.size.x + id.x;
    let samples = f32(displayParams.samples);
    let total = max(normal[i].a / samples, 1.0 / samples);
    let hit = albedo[i].a / samples;
    let divisor = select(total, hit, hit > 0.0 && displayParams.flat == 0u);
    displayColor[i] = vec4f(filtered[i].rgb * divisor, filtered[i].a);
}
