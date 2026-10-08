import { glsl } from '../../shader';
import { uvProjectionConstants } from '../../MergedMaterialData';

export default glsl`
vec2 sphericalProjection(vec3 pos) {
  vec3 n = normalize(pos);
  float theta = atan(n.x, n.z) / (2.0 * PI) + 0.5;
  float phi = acos(n.y) / PI;
  return vec2(theta, 1.0 - phi);
}

vec2 triplanarProjection(vec3 pos, vec3 normal, vec2 uvScale) {
  vec3 absNormal = abs(normal);
  vec2 uv = vec2(0.0);
  if (absNormal.x > absNormal.y && absNormal.x > absNormal.z) {
    uv = pos.yz;
  } else if (absNormal.y > absNormal.x && absNormal.y > absNormal.z) {
    uv = pos.xz;
  } else {
    uv = pos.xy;
  }
  return fract(uv * uvScale);
}

// vec4 triplanarProjectionSample(
//   sampler2DArray _map, vec2 mapSize, int index,
//   vec3 pos, vec3 normal, vec2 uvScale, float blending
// ) {
//   vec3 absNormal = abs(normal);
//   // Calculate blending power - higher expo means sharper transitions
//   float expo = (1.0 - blending) * 125.0 + blending * 3.0;
  
//   // Weight each axis by its normal component raised to expo power
//   vec3 weights = pow(absNormal, vec3(expo));
  
//   // Normalize weights so they sum to 1
//   weights = weights / (weights.x + weights.y + weights.z);
  
//   // Project UVs on each axis plane (yz, xz, xy)
//   vec2 yzPlane = pos.yz * uvScale;
//   vec2 xzPlane = pos.xz * uvScale;
//   vec2 xyPlane = pos.xy * uvScale;
//   // Wrap
//   yzPlane = fract(yzPlane);
//   xzPlane = fract(xzPlane);
//   xyPlane = fract(xyPlane);

//   // Sample maps
//   vec4 yz = texture(_map, vec3(yzPlane * mapSize, float(index)));
//   vec4 xz = texture(_map, vec3(xzPlane * mapSize, float(index)));
//   vec4 xy = texture(_map, vec3(xyPlane * mapSize, float(index)));
  
//   // Blend the projected coordinates using the weights
//   return weights.x * yz + weights.y * xz + weights.z * xy;
// }

vec2 cylindricalProjection(vec3 pos, vec3 normal) {
  float theta = atan(pos.z, pos.x) / (2.0 * PI) + 0.5;
  return vec2(theta, pos.y);
}

vec2 projectUV(int projectionType, vec3 pos, vec3 normal, vec2 uvScale) {
  if (projectionType == ${uvProjectionConstants.triplanar + ''}) {
    return triplanarProjection(pos, normal, uvScale);
  } else if (projectionType == ${uvProjectionConstants.spherical + ''}) {
    return sphericalProjection(pos) * uvScale;
  } else if (projectionType == ${uvProjectionConstants.cylindrical + ''}) {
    return cylindricalProjection(pos, normal) * uvScale;
  }
  return vec2(0.0);
}
`;
