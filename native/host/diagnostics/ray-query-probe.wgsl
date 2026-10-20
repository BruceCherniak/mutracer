// Analytic probe for wgpu 30 ray-query contracts, independent of the renderer.
enable wgpu_ray_query;
struct ProbeRay { originMax: vec4f, directionMask: vec4f, acceptance: vec4u }
@group(0) @binding(0) var scene: acceleration_structure;
@group(0) @binding(1) var<storage, read> rays: array<ProbeRay>;
@group(0) @binding(2) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let ray = rays[id.x];
    var query: ray_query;
    rayQueryInitialize(&query, scene, RayDesc(ray.acceptance.x, u32(ray.directionMask.w),
        0.001, ray.originMax.w, ray.originMax.xyz, ray.directionMask.xyz));
    let generatedT = bitcast<f32>(ray.acceptance.w);
    var candidates = 0u;
    while rayQueryProceed(&query) {
        let candidate = rayQueryGetCandidateIntersection(&query);
        candidates++;
        if (candidate.kind == RAY_QUERY_INTERSECTION_TRIANGLE
            && (ray.acceptance.y == 0xffffffffu || candidate.instance_custom_data == ray.acceptance.y)
            && (ray.acceptance.z == 0xffffffffu || candidate.primitive_index == ray.acceptance.z)) {
            rayQueryConfirmIntersection(&query);
        }
        if (candidate.kind == RAY_QUERY_INTERSECTION_AABB && ray.acceptance.w != 0u) {
            rayQueryGenerateIntersection(&query, generatedT);
        }
    }
    let hit = rayQueryGetCommittedIntersection(&query);
    output[id.x * 3u] = vec4f(f32(hit.kind), hit.t, f32(hit.instance_custom_data), f32(hit.primitive_index));
    output[id.x * 3u + 1u] = vec4f(hit.barycentrics, select(0.0, 1.0, hit.front_face), f32(candidates));
    output[id.x * 3u + 2u] = vec4f(f32(hit.instance_index), f32(hit.geometry_index), 0.0, 0.0);
}
