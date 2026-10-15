// Ray-query API usage follows gfx-rs/wgpu v30.0.1's ray_traced_triangle example:
// https://github.com/gfx-rs/wgpu/blob/v30.0.1/examples/features/src/ray_traced_triangle/shader.wgsl
// Copyright (c) 2025 The gfx-rs developers. MIT; see LICENSES/Wgpu-MIT.txt.
// Modified for analytic hit/miss, mask, distance and instance verification.
enable wgpu_ray_query;

struct ProbeRay { originAndMax: vec4f, directionAndMask: vec4f }
@group(0) @binding(0) var scene: acceleration_structure;
@group(0) @binding(1) var<storage, read> rays: array<ProbeRay>;
@group(0) @binding(2) var<storage, read_write> output: array<vec4f>;

@compute @workgroup_size(8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let ray = rays[id.x];
    var query: ray_query;
    rayQueryInitialize(&query, scene, RayDesc(0u, u32(ray.directionAndMask.w),
        0.001, ray.originAndMax.w, ray.originAndMax.xyz, ray.directionAndMask.xyz));
    while rayQueryProceed(&query) {}
    let hit = rayQueryGetCommittedIntersection(&query);
    output[id.x * 2u] = vec4f(f32(hit.kind), hit.t,
        f32(hit.instance_custom_data), f32(hit.primitive_index));
    output[id.x * 2u + 1u] = vec4f(hit.barycentrics, 0.0, 0.0);
}
