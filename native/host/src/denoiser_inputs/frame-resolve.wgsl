struct FramePixel {
    noisyColor: vec4f, normalRoughness: vec4f, positionDepth: vec4f,
    geometricNormal: vec4f, baseColorMetalness: vec4f, transmission: vec4f,
    roughnessIor: vec4f, absorption: vec4f, identity: vec4u,
    barycentricsFace: vec4f, unclampedRadiance: vec4f,
    rngState: vec4u, rngDimensions: vec4u,
    diffuseAlbedo: vec4f, specularAlbedo: vec4f,
}
@group(0) @binding(0) var<storage, read> pixels: array<FramePixel>;
@group(0) @binding(1) var color: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var normal: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var depth: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var validity: texture_storage_2d<r32uint, write>;
@group(0) @binding(5) var diffuse: texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var specular: texture_storage_2d<rgba32float, write>;
@group(0) @binding(7) var motion: texture_storage_2d<rg32float, write>;
struct Correspondence {
    currentViewProjection: mat4x4f,
    previousViewProjection: mat4x4f,
    previousEye: vec4f,
    previousForward: vec4f,
    previousJitter: vec4f,
    enabled: vec4u,
}
@group(0) @binding(8) var<uniform> correspondence: Correspondence;
@group(0) @binding(9) var<storage, read> previousPixels: array<FramePixel>;
// Returns prev-current in unjittered input pixels. The lookup into the previous
// sampled image removes its jitter once; it never adds jitter to the motion.
fn cameraMotion(pixel: FramePixel, size: vec2u) -> vec3f {
    if (correspondence.enabled.x == 0u || (pixel.identity.w & 33u) != 1u) { return vec3f(0.0); }
    let position = vec4f(pixel.positionDepth.xyz, 1.0);
    let a = correspondence.currentViewProjection * position;
    let b = correspondence.previousViewProjection * position;
    if (a.w <= 0.0 || b.w <= 0.0 || !all(abs(a) < vec4f(3.402823e38))
        || !all(abs(b) < vec4f(3.402823e38))) { return vec3f(0.0); }
    let current = a.xyz / a.w;
    let previous = b.xyz / b.w;
    if (abs(previous.z) > 1.0 || abs(current.z) > 1.0) { return vec3f(0.0); }
    let scale = vec2f(size);
    let currentPixel = vec2f(current.x * 0.5 + 0.5, 0.5 - current.y * 0.5) * scale;
    let previousPixel = vec2f(previous.x * 0.5 + 0.5, 0.5 - previous.y * 0.5) * scale;
    let lookup = previousPixel - correspondence.previousJitter.xy;
    if (any(lookup < vec2f(0.0)) || any(lookup >= scale)) { return vec3f(0.0); }
    let p = vec2u(floor(lookup));
    let sample = previousPixels[p.x + (size.y - 1u - p.y) * size.x];
    if ((sample.identity.w & 33u) != 1u || any(sample.identity.xy != pixel.identity.xy)) { return vec3f(0.0); }
    let depth = dot(pixel.positionDepth.xyz - correspondence.previousEye.xyz, correspondence.previousForward.xyz);
    if (abs(depth - sample.positionDepth.w) > max(1e-4, abs(depth) * 1e-3)
        || dot(sample.geometricNormal.xyz, pixel.geometricNormal.xyz) < 0.9) { return vec3f(0.0); }
    return vec3f(previousPixel - currentPixel, 1.0);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) p: vec3u) {
    let size = textureDimensions(color);
    if (any(p.xy >= size)) { return; }
    // The integrator stores bottom-row-first; all frame textures are top-row-first.
    let pixel = pixels[p.x + (size.y - 1u - p.y) * size.x];
    textureStore(color, vec2i(p.xy), pixel.noisyColor);
    textureStore(normal, vec2i(p.xy), pixel.normalRoughness);
    textureStore(depth, vec2i(p.xy), vec4f(pixel.positionDepth.w));
    let correspondenceMotion = cameraMotion(pixel, size);
    var flags = pixel.identity.w;
    if ((flags & 1u) != 0u) {
        flags |= select(64u, 2u, correspondenceMotion.z > 0.0);
    }
    textureStore(motion, vec2i(p.xy), vec4f(correspondenceMotion.xy, 0.0, 0.0));
    textureStore(validity, vec2i(p.xy), vec4u(flags));
    textureStore(diffuse, vec2i(p.xy), pixel.diffuseAlbedo);
    textureStore(specular, vec2i(p.xy), pixel.specularAlbedo);
}
