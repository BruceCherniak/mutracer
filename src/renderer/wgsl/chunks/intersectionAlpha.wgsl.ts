import { INSTANCE_VEC4_STRIDE } from '../../bvhAccel';
import { uvProjectionConstants } from '../../MergedMaterialData';
import OpenPBRMaterial, {
  materialAlphaModeConstants
} from '../../../scene/OpenPBRMaterial';

/**
 * Material coverage shared by software BVH traversal and native RayQuery
 * candidate filtering. The caller supplies local-space hit data so UV
 * projection and stochastic glTF BLEND semantics stay backend-independent.
 */
const intersectionAlphaWgsl = /* wgsl */ `
fn intersectionAlphaPasses(
  initialMaterialIndex: i32,
  instanceIndex: i32,
  index: vec3i,
  hitBarycentric: vec3f,
  hitPosition: vec3f,
  hitNormal: vec3f
) -> bool {
  var materialIndex = initialMaterialIndex;
  let m0 = vec3i(attrBuffers[index.x * ATTR_STRIDE + MATERIALINDEX_OFF]);
  let m1 = vec3i(attrBuffers[index.y * ATTR_STRIDE + MATERIALINDEX_OFF]);
  let m2 = vec3i(attrBuffers[index.z * ATTR_STRIDE + MATERIALINDEX_OFF]);

  if (m0.x > 0 || m1.x > 0 || m2.x > 0) {
    materialIndex = randomPickMaterial(m0, m1, m2, hitBarycentric);
  }

  var ma = materialsBuffer[materialIndex];
  let projection = instancesBuffer[instanceIndex * ${INSTANCE_VEC4_STRIDE} + 9].x;
  if (projection >= 0.0) { ma.uvProjection = projection; }
  var alpha = ma.alpha;
  if (USE_DIFFUSE_MAPS &&
      ma.mapAlphaUsage == ${OpenPBRMaterial.mapAlphaUsageAlpha}) {
    let diffuseMapIndex = i32(ma.diffuseMapIndex);
    if (diffuseMapIndex >= 0) {
      let uvProjection = i32(ma.uvProjection);
      let uv0 = attrBuffers[index.x * ATTR_STRIDE + UV_OFF].xy;
      let uv1 = attrBuffers[index.y * ATTR_STRIDE + UV_OFF].xy;
      let uv2 = attrBuffers[index.z * ATTR_STRIDE + UV_OFF].xy;
      var uv = hitBarycentric.x * uv0 +
        hitBarycentric.y * uv1 + hitBarycentric.z * uv2;
      if (uvProjection > 0) {
        uv = projectUV(uvProjection, hitPosition, hitNormal);
      }
      uv *= ma.uvScale;
      if (uvProjection == ${uvProjectionConstants.triplanar}) {
        uv = fract(uv);
      }
      alpha *= sampleMap(diffuseMapIndex, uv).a;
    }
  }

  if (USE_ALPHA_MAPS) {
    let alphaMapIndex = i32(ma.alphaMapIndex);
    if (alphaMapIndex >= 0) {
      let uvProjection = i32(ma.uvProjection);
      let uv0 = attrBuffers[index.x * ATTR_STRIDE + UV_OFF].xy;
      let uv1 = attrBuffers[index.y * ATTR_STRIDE + UV_OFF].xy;
      let uv2 = attrBuffers[index.z * ATTR_STRIDE + UV_OFF].xy;
      var uv = hitBarycentric.x * uv0 +
        hitBarycentric.y * uv1 + hitBarycentric.z * uv2;
      if (uvProjection > 0) {
        uv = projectUV(uvProjection, hitPosition, hitNormal);
      }
      uv *= ma.uvScale;
      if (uvProjection == ${uvProjectionConstants.triplanar}) {
        uv = fract(uv);
      }
      alpha *= sampleMap(alphaMapIndex, uv).g;
    }
  }

  let alphaMode = i32(ma.alphaMode);
  if (alphaMode == ${materialAlphaModeConstants.opaque}) {
    alpha = 1.0;
  }
  else if (alphaMode == ${materialAlphaModeConstants.mask}) {
    alpha = select(0.0, 1.0, alpha >= ma.alphaCutoff);
  }
  if (alphaMode == ${materialAlphaModeConstants.blend}) {
    return randomSample() <= alpha;
  }
  return alpha >= 1.0;
}
`;

export default intersectionAlphaWgsl;
