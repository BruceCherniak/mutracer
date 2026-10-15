// Native experimental hybrid: hardware selects a triangle; the existing
// watertight test and surface completion preserve MuTracer attribute arithmetic.
// Unsupported/rejected hits retain the original software traversal.
@group(0) @binding(4) var mtAcceleration: acceleration_structure;
@group(0) @binding(5) var<storage, read> mtTriangleRecords: array<u32>;
@group(0) @binding(6) var<storage, read_write> mtQueryCounts: array<atomic<u32>>;
const MT_VALIDATE_SHADOWS: bool = false;
const MT_SOFTWARE_CLOSEST: bool = false;

fn mtCheckedShadow(ray: Ray, distance: f32, triangle: i32, result: bool) -> bool {
  if (MT_VALIDATE_SHADOWS) {
    atomicAdd(&mtQueryCounts[8], 1u);
    if (result != intersectSceneShadowSoftware(ray, distance, triangle)) {
      atomicAdd(&mtQueryCounts[9], 1u);
    }
  }
  return result;
}

fn intersectScene(ray: Ray, si: ptr<function, SurfaceInteraction>, bounces: i32,
    doubleSided: bool, isRefractionRay: bool) {
  if (MT_SOFTWARE_CLOSEST) {
    intersectSceneSoftware(ray, si, bounces, doubleSided, isRefractionRay);
    return;
  }
  (*si).hit = false;
  if (rtUniform.isEmpty > 0) { return; }
  atomicAdd(&mtQueryCounts[0], 1u);
  var query: ray_query;
  rayQueryInitialize(&query, mtAcceleration,
    RayDesc(0u, 255u, 0.0, RAY_MAX_DISTANCE, ray.o, ray.d));
  while rayQueryProceed(&query) {}
  let hit = rayQueryGetCommittedIntersection(&query);
  if (hit.kind == RAY_QUERY_INTERSECTION_NONE) {
    atomicAdd(&mtQueryCounts[2], 1u);
    // Affine transforms can put hardware/software silhouette tests on opposite
    // sides of zero. Preserve the original watertight result on query misses.
    atomicAdd(&mtQueryCounts[1], 1u);
    intersectSceneSoftware(ray, si, bounces, doubleSided, isRefractionRay);
    if ((*si).hit) { atomicAdd(&mtQueryCounts[10], 1u); }
    return;
  }
  let instance = i32(hit.instance_custom_data);
  let record = i32(mtTriangleRecords[mtTriangleRecords[instance] + hit.primitive_index]);
  let instanceData = instancesBuffer[instance * 10];
  let indices = bitcast<vec3i>(bvhBuffer[record].xyz) + vec3i(bitcast<i32>(instanceData.y));
  let tri = Triangle(attrBuffers[indices.x * ATTR_STRIDE + POSITION_OFF].xyz,
    attrBuffers[indices.y * ATTR_STRIDE + POSITION_OFF].xyz,
    attrBuffers[indices.z * ATTR_STRIDE + POSITION_OFF].xyz);
  let worldToLocal = mat4x4f(instancesBuffer[instance * 10 + 1],
    instancesBuffer[instance * 10 + 2], instancesBuffer[instance * 10 + 3],
    instancesBuffer[instance * 10 + 4]);
  let origin = (worldToLocal * vec4f(ray.o, 1.0)).xyz;
  let direction = (worldToLocal * vec4f(ray.d, 0.0)).xyz;
  let dimension = maxDimension(abs(direction));
  let exact = intersectTriangle(origin, direction, tri, dimension,
    getShear(direction, dimension), RAY_MAX_DISTANCE);
  let normal = normalize(cross(tri.p1 - tri.p0, tri.p2 - tri.p0));
  let materialIndex = i32(unpackMaterialIndex(bitcast<i32>(instanceData.z)).x);
  let rejectedBackFace = !doubleSided && materialsBuffer[materialIndex].doubleSided <= 0.5
    && dot(normal, direction) > 0.0;
  // Keep exact software behavior for self intersections, shared-edge ties and
  // numerical disagreements rather than advancing tmin past another valid hit.
  if ((bounces > 0 && record == (*si).triangleIndex) || rejectedBackFace
      || exact.t <= 0.0 || min(min(exact.barycentric.x, exact.barycentric.y), exact.barycentric.z) < 1e-3) {
    atomicAdd(&mtQueryCounts[1], 1u);
    intersectSceneSoftware(ray, si, bounces, doubleSided, isRefractionRay);
    return;
  }
  (*si).triangleIndex = record;
  completeSurfaceInteraction(si, tri, exact.barycentric, indices, false, instance,
    normal, origin + exact.t * direction, -1);
  atomicAdd(&mtQueryCounts[3], 1u);
}

fn intersectSceneShadow(ray: Ray, lightDistance: f32, currTriangleIndex: i32) -> bool {
  if (rtUniform.isEmpty > 0) { return false; }
  let limit = min(max(lightDistance, 0.0), RAY_MAX_DISTANCE);
  if (limit <= 0.0) { return false; }
  atomicAdd(&mtQueryCounts[4], 1u);
  var query: ray_query;
  rayQueryInitialize(&query, mtAcceleration,
    RayDesc(0u, 255u, 0.0, limit, ray.o, ray.d));
  while rayQueryProceed(&query) {}
  let hit = rayQueryGetCommittedIntersection(&query);
  if (hit.kind == RAY_QUERY_INTERSECTION_NONE) {
    atomicAdd(&mtQueryCounts[6], 1u);
    return mtCheckedShadow(ray, lightDistance, currTriangleIndex, false);
  }
  let instance = i32(hit.instance_custom_data);
  let record = i32(mtTriangleRecords[mtTriangleRecords[instance] + hit.primitive_index]);
  let instanceData = instancesBuffer[instance * 10];
  let indices = bitcast<vec3i>(bvhBuffer[record].xyz) + vec3i(bitcast<i32>(instanceData.y));
  let tri = Triangle(attrBuffers[indices.x * ATTR_STRIDE + POSITION_OFF].xyz,
    attrBuffers[indices.y * ATTR_STRIDE + POSITION_OFF].xyz,
    attrBuffers[indices.z * ATTR_STRIDE + POSITION_OFF].xyz);
  let worldToLocal = mat4x4f(instancesBuffer[instance * 10 + 1],
    instancesBuffer[instance * 10 + 2], instancesBuffer[instance * 10 + 3],
    instancesBuffer[instance * 10 + 4]);
  let origin = (worldToLocal * vec4f(ray.o, 1.0)).xyz;
  let direction = (worldToLocal * vec4f(ray.d, 0.0)).xyz;
  let dimension = maxDimension(abs(direction));
  let exact = intersectTriangle(origin, direction, tri, dimension,
    getShear(direction, dimension), limit);
  // Match the original record-based self-hit skip, including shared BLASes.
  // Re-run traversal when hardware and watertight arithmetic could disagree.
  if (record == currTriangleIndex || exact.t <= 0.0
      || abs(exact.t - limit) < 1e-5 * max(1.0, limit)
      || min(min(exact.barycentric.x, exact.barycentric.y), exact.barycentric.z) < 1e-5) {
    atomicAdd(&mtQueryCounts[5], 1u);
    return mtCheckedShadow(ray, lightDistance, currTriangleIndex,
      intersectSceneShadowSoftware(ray, lightDistance, currTriangleIndex));
  }
  atomicAdd(&mtQueryCounts[7], 1u);
  return mtCheckedShadow(ray, lightDistance, currTriangleIndex, true);
}
