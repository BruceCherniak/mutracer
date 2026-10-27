// The browser's cleanAuxLarge path: sRGB albedo, encoded normals, two LDR
// networks, linear albedo decode and normal sanitization before beauty OIDN.
struct Params { size: vec2u, samples: u32, flat: u32 }
@group(0) @binding(0) var<storage, read> albedo: array<vec4f>;
@group(0) @binding(1) var<storage, read> normal: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> encodedAlbedo: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> encodedNormal: array<vec4f>;
@group(0) @binding(4) var<storage, read> filteredAlbedo: array<vec4f>;
@group(0) @binding(5) var<storage, read> filteredNormal: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> cleanAlbedo: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> cleanNormal: array<vec4f>;
@group(0) @binding(8) var<uniform> params: Params;
@compute @workgroup_size(8,8)
fn encode(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= params.size)) { return; }
    let i = id.y * params.size.x + id.x;
    let linear = clamp(albedo[i].rgb,vec3f(0.),vec3f(1.));
    let srgb = select(1.055 * pow(linear,vec3f(1./2.4))-0.055,12.92*linear,linear <= vec3f(0.0031308));
    encodedAlbedo[i] = vec4f(srgb,albedo[i].a);
    encodedNormal[i] = vec4f(clamp(normal[i].rgb * 0.5 + 0.5,vec3f(0.),vec3f(1.)),1.);
}
@compute @workgroup_size(8,8)
fn decode(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= params.size)) { return; }
    let i = id.y * params.size.x + id.x;
    let srgb = clamp(filteredAlbedo[i].rgb,vec3f(0.),vec3f(1.));
    let linear = select(pow((srgb+0.055)/1.055,vec3f(2.4)),srgb/12.92,srgb <= vec3f(0.04045));
    cleanAlbedo[i] = vec4f(linear,1.);
    cleanNormal[i] = vec4f(clamp(filteredNormal[i].rgb,vec3f(0.),vec3f(1.))*2.-1.,1.);
}
