@group(0) @binding(0) var<storage, read> color: array<vec4f>;
@group(0) @binding(1) var<storage, read> normal: array<vec4f>;
@group(0) @binding(2) var<storage, read> albedo: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> outputColor: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> outputNormal: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> outputAlbedo: array<vec4f>;
@group(0) @binding(6) var<uniform> parameters: vec4u;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= parameters.y || id.y >= parameters.z) { return; }
    let index = id.x + id.y * parameters.y;
    let samples = f32(parameters.x);
    outputColor[index] = color[index] / samples;
    outputNormal[index] = normal[index] / samples;
    outputAlbedo[index] = albedo[index] / samples;
}
