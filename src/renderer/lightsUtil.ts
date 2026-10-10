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
      light.type === 'RectLight' ? RectLight.getPosition(light) : light.position
    );
    data[off * 4 + 3] = selectionPmfs[i] ?? 1 / Math.max(numLights, 1);
    // emission
    const emissionScale =
      light.type === 'SpotLight' ? SpotLight.getRadiance(light) : intensity;
    packVec3(off + 1, [
      color[0] * emissionScale,
      color[1] * emissionScale,
      color[2] * emissionScale
    ]);
    data[(off + 1) * 4 + 3] = selectionCdfs[i] ?? (i + 1) / numLights;
    if (light.type === 'RectLight') {
      packVec3(off + 2, RectLight.getUOrV(light, 0));
      data[(off + 2) * 4 + 3] = light.spread;
      packVec3(off + 3, RectLight.getUOrV(light, 1));
      data[(off + 3) * 4 + 3] = texturesIndices[i];
      packVec3(off + 4, [
        light.spread,
        RectLight.getArea(light),
        CONSTANT_RECT_LIGHT
      ]);
    } else if (light.type === 'SphereLight') {
      packVec3(off + 4, [
        light.radius,
        SphereLight.getArea(light),
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
        SpotLight.getArea(light),
        CONSTANT_SPOT_LIGHT
      ]);
    } else if (light.type === 'DirectionalLight') {
      packVec3(off + 4, [0, 0, CONSTANT_DIRECTIONAL_LIGHT]);
    }
  }

  return data;
}
