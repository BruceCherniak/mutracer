// These entry points use their own output bindings and never mutate beauty RNG
// state or accumulation. Storage usage remains four scene + three AOV buffers.
export default /* wgsl */ `
struct AovAccumulation {
  depthRoughness: vec4f,
  position: vec4f,
  diffuse: vec4f,
  specular: vec4f,
}
struct AovCenter { identity: vec4u, motion: vec4f, }
@group(3) @binding(5) var<storage, read_write> aovAccum: array<AovAccumulation>;
@group(3) @binding(6) var<storage, read_write> aovCenter: array<AovCenter>;
@group(3) @binding(7) var<storage, read> aovScene: array<u32>;
@group(3) @binding(9) var<storage, read> aovPrevious: array<AovCenter>;
@group(3) @binding(8) var<uniform> aovParameters: vec4u;

fn aovMatrix(offset: u32) -> mat4x4f {
  return mat4x4f(bitcast<vec4f>(vec4u(aovScene[offset], aovScene[offset+1u], aovScene[offset+2u], aovScene[offset+3u])),
    bitcast<vec4f>(vec4u(aovScene[offset+4u], aovScene[offset+5u], aovScene[offset+6u], aovScene[offset+7u])),
    bitcast<vec4f>(vec4u(aovScene[offset+8u], aovScene[offset+9u], aovScene[offset+10u], aovScene[offset+11u])),
    bitcast<vec4f>(vec4u(aovScene[offset+12u], aovScene[offset+13u], aovScene[offset+14u], aovScene[offset+15u])));
}
fn aovSurface(rayInput: Ray, si: ptr<function, SurfaceInteraction>, material: ptr<function, OpenPbrResolvedMaterial>) -> bool {
  var ray = rayInput;
  (*si).triangleIndex = -1;
  for (var layer = 0; layer < 32; layer++) {
    intersectScene(ray, si, 0, false, false);
    if (!(*si).hit) { return false; }
    getMaterial(material, (*si).materialIndex, (*si).uv, (*si).uv1, (*si).instanceIndex, (*si).vertexColor);
    if ((*material).materialType != SHADOW_CATCHER && (*material).alpha >= 0.5) { return true; }
    ray.o = (*si).position + ray.d * (EPS * 0.02);
  }
  return false;
}
@compute @workgroup_size(8, 8)
fn aovTrace(@builtin(global_invocation_id) id: vec3u) {
  let size = aovParameters.xy;
  if (any(id.xy >= size)) { return; }
  let index = id.x + id.y * size.x;
  let sample = aovParameters.z;
  if (sample == 0u) { aovAccum[index] = AovAccumulation(); }
  samplingPixel = id.xy; pixelSampleIndex = sample + rtUniform.sampleSequenceOffset;
  samplingBounce = 0u; hashedCounter = 0u;
  rng_initialize(id.xy, i32(pixelSampleIndex ^ sampleHash(rtUniform.sequenceSeed)));
  let uv = (vec2f(id.xy) + sample2D(CAMERA_PIXEL)) / vec2f(size);
  var ray = initCameraRay(uv);
  if (cameraUniform.apertureRadius > 0.0) {
    let eye = cameraUniform.viewInv[3].xyz;
    let forward = -normalize(cameraUniform.viewInv[2].xyz);
    let focusPoint = eye + ray.d * (cameraUniform.focusDistance / dot(ray.d, forward));
    let lens = cameraUniform.apertureRadius * sampleCircle(sample2D(CAMERA_LENS));
    let origin = (cameraUniform.viewInv * vec4f(lens, 0.0, 1.0)).xyz;
    initRay(&ray, origin, normalize(focusPoint-origin));
  }
  var si: SurfaceInteraction; var material: OpenPbrResolvedMaterial;
  if (!aovSurface(ray, &si, &material)) { return; }
  let depth = max(dot(si.position-cameraUniform.viewInv[3].xyz, -normalize(cameraUniform.viewInv[2].xyz)), 0.0);
  aovAccum[index].depthRoughness += vec4f(depth, material.specularRoughness, material.baseMetalness, 0.0);
  aovAccum[index].position += vec4f(si.position, 1.0);
}
@compute @workgroup_size(8, 8)
fn aovTraceCenter(@builtin(global_invocation_id) id: vec3u) {
  let size = aovParameters.xy;
  if (any(id.xy >= size)) { return; }
  let index = id.x + id.y * size.x;
  aovCenter[index] = AovCenter(vec4u(0xffffffffu), vec4f(0.0));
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let ray = initCameraRay(uv);
  var si: SurfaceInteraction; var material: OpenPbrResolvedMaterial;
  if (!aovSurface(ray, &si, &material)) { return; }
  let offset = 36u + u32(si.instanceIndex) * 24u;
  let materialOffset = aovScene[16u];
  let primitiveOffset = aovScene[17u];
  aovCenter[index].identity = vec4u(aovScene[offset], aovScene[offset+1u],
    aovScene[materialOffset + u32(si.materialIndex)], aovScene[primitiveOffset + u32(si.triangleIndex)]);
  let clip = aovMatrix(20u) * vec4f(si.position,1.0);
  aovCenter[index].motion.z = clip.z / clip.w;
  if (aovScene[offset+2u] == 0u) { return; }
  let oldClip = aovMatrix(0u) * aovMatrix(offset+4u) * vec4f(si.position,1.0);
  if (oldClip.w <= 0.0) { return; }
  let oldNdc=oldClip.xyz/oldClip.w;
  let oldPixel=(oldNdc.xy*0.5+0.5)*vec2f(size);
  if (any(oldPixel < vec2f(0.0)) || any(oldPixel >= vec2f(size)) || abs(oldNdc.z)>1.0) { return; }
  let previous=aovPrevious[u32(oldPixel.x)+u32(oldPixel.y)*size.x];
  if (any(previous.identity.xy != aovCenter[index].identity.xy) || abs(previous.motion.z-oldNdc.z)>0.001) { return; }
  let motion=(oldPixel-(vec2f(id.xy)+0.5))*vec2f(1.0,-1.0);
  aovCenter[index].motion=vec4f(motion,aovCenter[index].motion.z,3.0);
}
`;
