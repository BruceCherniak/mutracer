// OIDN's LDR auxiliary networks use sRGB albedo and normals in [0,1].
export const oidnAuxiliaryDefine = /* wgsl */ `
fn oidnEncodeAlbedo(value: vec3f) -> vec3f {
  let linear = clamp(value, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055,
    12.92 * linear, linear <= vec3f(0.0031308));
}
fn oidnDecodeAlbedo(value: vec3f) -> vec3f {
  let encoded = clamp(value, vec3f(0.0), vec3f(1.0));
  return select(pow((encoded + 0.055) / 1.055, vec3f(2.4)),
    encoded / 12.92, encoded <= vec3f(0.04045));
}
fn oidnSanitizeNormal(value: vec3f) -> vec3f {
  return clamp(value, vec3f(0.0), vec3f(1.0));
}
`;
