import { uvProjectionConstants } from '../../MergedMaterialData.js';

export default /* wgsl */ `

fn sphericalProjection(pos: vec3f) -> vec2f {
  let n = normalize(pos);
  let theta = atan2(n.x, n.z) / (2.0 * PI) + 0.5;
  let phi = acos(n.y) / PI;
  return vec2f(theta, 1.0 - phi);
}
fn triplanarProjection(pos: vec3f, normal: vec3f) -> vec2f {
  let absNormal = abs(normal);
  var uv = vec2f(0.0);
  if (absNormal.x > absNormal.y && absNormal.x > absNormal.z) {
    uv = pos.yz;
  } else if (absNormal.y > absNormal.x && absNormal.y > absNormal.z) {
    uv = pos.xz;
  } else {
    uv = pos.xy;
  }
  return uv;
}




fn cylindricalProjection(pos: vec3f, normal: vec3f) -> vec2f {
  let theta = atan2(pos.z, pos.x) / (2.0 * PI) + 0.5;
  return vec2f(theta, pos.y);
}

fn projectUV(projectionType: i32, pos: vec3f, normal: vec3f) -> vec2f {
  if (projectionType == ${uvProjectionConstants.triplanar}) {
    return triplanarProjection(pos, normal);
  } else if (projectionType == ${uvProjectionConstants.spherical}) {
    return sphericalProjection(pos);
  } else if (projectionType == ${uvProjectionConstants.cylindrical}) {
    return cylindricalProjection(pos, normal);
  }
  return vec2f(0.0);
}
`;
