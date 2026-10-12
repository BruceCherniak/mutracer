import { mat3, vec3 } from '../math.js';
import DirectionalLight from '../scene/DirectionalLight.js';
import SphereLight from '../scene/SphereLight.js';
import RectLight from '../scene/RectLight.js';
import SpotLight from '../scene/SpotLight.js';

export const CONSTANT_DIRECTIONAL_LIGHT = 1;
export const CONSTANT_SPHERE_LIGHT = 2;
export const CONSTANT_RECT_LIGHT = 3;
export const CONSTANT_SPOT_LIGHT = 4;

export function packLightsToBuffer(
  lights: (DirectionalLight | RectLight | SphereLight | SpotLight)[],
  texturesIndices: number[],
  selectionPmfs: ArrayLike<number> = [],
  selectionCdfs: ArrayLike<number> = [],
  iesProfileTexelOffsets: ArrayLike<number> = []
) {
  const numLights = lights.length;
  const PIXELS_PER_LIGHT = 5;
  const data = new Float32Array(numLights * PIXELS_PER_LIGHT * 4);

  function packVec3(idx: number, v: number[] | Float32Array) {
    for (let i = 0; i < 3; i++) {
      data[i + idx * 4] = v[i];
    }
  }

  for (let i = 0; i < numLights; i++) {
    const light = lights[i];
    const color = light.color;
    const intensity = light.intensity;
    const off = i * PIXELS_PER_LIGHT;
    packVec3(
      off,
      light.type === 'RectLight' ? getRectLightPosition(light) : light.position
    );
    data[off * 4 + 3] = selectionPmfs[i] ?? 1 / Math.max(numLights, 1);
    // emission
    const emissionScale =
      light.type === 'SpotLight' ? getSpotLightRadiance(light) : intensity;
    packVec3(off + 1, [
      color[0] * emissionScale,
      color[1] * emissionScale,
      color[2] * emissionScale
    ]);
    data[(off + 1) * 4 + 3] = selectionCdfs[i] ?? (i + 1) / numLights;
    if (light.type === 'RectLight') {
      packVec3(off + 2, getRectLightUOrV(light, 0));
      data[(off + 2) * 4 + 3] = light.spread;
      packVec3(off + 3, getRectLightUOrV(light, 1));
      data[(off + 3) * 4 + 3] = texturesIndices[i];
      packVec3(off + 4, [
        light.spread,
        getRectLightArea(light),
        CONSTANT_RECT_LIGHT
      ]);
    } else if (light.type === 'SphereLight') {
      packVec3(off + 4, [
        light.radius,
        getSphereLightArea(light),
        CONSTANT_SPHERE_LIGHT
      ]);
    } else if (light.type === 'SpotLight') {
      packVec3(off + 2, light.direction);
      packVec3(off + 3, [
        Math.cos((light.outerAngle * Math.PI) / 180),
        Math.min(1, Math.max(0, 1 - light.innerAngle / light.outerAngle)),
        (light.iesRotation * Math.PI) / 180
      ]);
      data[(off + 3) * 4 + 3] = iesProfileTexelOffsets[i] ?? -1;
      packVec3(off + 4, [
        light.radius,
        getSpotLightArea(light),
        CONSTANT_SPOT_LIGHT
      ]);
    } else if (light.type === 'DirectionalLight') {
      packVec3(off + 4, [0, 0, CONSTANT_DIRECTIONAL_LIGHT]);
    }
  }

  return data;
}

export function getRectLightUOrV(light: RectLight, uOrV: 0 | 1) {
    // On the xy plane and point to negative z
    const ret = vec3.fromValues(0, 0, 0);
    // Inverse the v
    ret[uOrV] = (uOrV ? -1 : 1) * light.size[uOrV];
    return vec3.transformMat3(
      ret,
      ret,
      mat3.fromMat4([] as any as mat3.Mat3Array, light.matrixWorld)
    );
}

export function getRectLightPosition(light: RectLight) {
    const m = light.matrixWorld;
    return vec3.fromValues(m[12], m[13], m[14]);
}

export function getRectLightArea(light: RectLight) {
    return light.size[0] * light.size[1];
}

export function getSphereLightArea(light: SphereLight) {
    return 4 * Math.PI * light.radius ** 2;
}

export function getSpotLightArea(light: SpotLight) {
    return 4 * Math.PI * light.radius ** 2;
}

export function getSpotLightRadiance(light: SpotLight) {
    // A zero-radius spot is a point emitter. Its stored emission is luminous
    // intensity (cd), and the shader applies inverse-square attenuation.
    if (light.radius === 0) return light.intensity;
    return light.intensity / (Math.PI * light.radius ** 2);
}

export function getSpotLightShapingFluxFactor(light: SpotLight) {
    const cosConeAngle = Math.cos((light.outerAngle * Math.PI) / 180);
    const softness = Math.min(
      1,
      Math.max(0, 1 - light.innerAngle / light.outerAngle)
    );
    return (1 - cosConeAngle) * (1 - 0.5 * softness) * 0.5;
}
