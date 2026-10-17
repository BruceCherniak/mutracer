import type { SceneLight, AnalyticLight } from '../scene/Scene.js';
import type { Vec3 } from '../types.js';
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
  validateSceneLights(lights);
  const numLights = lights.length;
  const PIXELS_PER_LIGHT = 6;
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
      light.position
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
      data[(off + 3) * 4 + 3] = texturesIndices[i] ?? -1;
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
      packVec3(off + 2, getLightDirection(light));
      packVec3(off + 3, [
        Math.cos((light.outerAngle * Math.PI) / 180),
        Math.min(1, Math.max(0, 1 - light.innerAngle / light.outerAngle)),
        0
      ]);
      data[(off + 3) * 4 + 3] = iesProfileTexelOffsets[i] ?? -1;
      packVec3(off + 4, [
        light.radius,
        getSpotLightArea(light),
        CONSTANT_SPOT_LIGHT
      ]);
    } else if (light.type === 'DirectionalLight') {
      packVec3(off + 2, getLightDirection(light));
      packVec3(off + 4, [0, 0, CONSTANT_DIRECTIONAL_LIGHT]);
    }
    packVec3(off + 5, getRigidLightFrame(light).x);
  }

  return data;
}

export function getRigidLightFrame(light: AnalyticLight) {
  const m = light.transform;
  const normalize = (v: Vec3, fallback: Vec3): Vec3 => {
    const length = Math.hypot(v[0], v[1], v[2]);
    return length > 1e-12 ? [v[0]/length, v[1]/length, v[2]/length] : fallback;
  };
  const z = normalize([m[8],m[9],m[10]], [0,0,1]);
  const projection = m[0]*z[0] + m[1]*z[1] + m[2]*z[2];
  let x: Vec3 = [m[0]-projection*z[0],m[1]-projection*z[1],m[2]-projection*z[2]];
  if (Math.hypot(...x) <= 1e-12) x = Math.abs(z[1]) < .99 ? [z[2],0,-z[0]] : [1,0,0];
  x = normalize(x, [1,0,0]);
  const y: Vec3 = [z[1]*x[2]-z[2]*x[1], z[2]*x[0]-z[0]*x[2], z[0]*x[1]-z[1]*x[0]];
  return { x, y, direction: [-z[0] || 0,-z[1] || 0,-z[2] || 0] as Vec3 };
}
export function getLightDirection(light: AnalyticLight) { return getRigidLightFrame(light).direction; }
export function getRectLightUOrV(light: RectLight, uOrV: 0 | 1) {
  const frame = getRigidLightFrame(light), axis = uOrV ? frame.y : frame.x;
  const size = light.size[uOrV] * (uOrV ? -1 : 1);
  return [axis[0]*size,axis[1]*size,axis[2]*size];
}
export function getRectLightPosition(light: RectLight) { return light.position; }

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

const warnedLights = new WeakSet<SceneLight>();
/** Sanitizes invalid mutable light values at the packing boundary; notifications are nonfatal. */
export function validateSceneLights(lights: readonly SceneLight[], onError?: (error: Error) => void) {
  for (const light of lights) {
    if (light.type === 'EnvironmentLight') continue;
    let invalid = false;
    const clamp = (value: number, min: number, max: number, fallback: number) => {
      const normalized = Math.min(max,Math.max(min,Number.isFinite(value) ? value : fallback));
      invalid ||= !Object.is(normalized,value);
      return normalized;
    };
    light.intensity = clamp(light.intensity,0,Number.MAX_VALUE,1);
    for(let i=0;i<3;i++)light.color[i] = clamp(light.color[i],0,Number.MAX_VALUE,1);
    if (light.type !== 'AmbientLight') {
      for(let i=0;i<16;i++) if (!Number.isFinite(light.transform[i])) {
        light.transform[i] = i % 5 === 0 ? 1 : 0; invalid = true;
      }
    }
    if (light.type === 'RectLight') {
      for(let i=0;i<2;i++)light.size[i] = clamp(light.size[i],0,Number.MAX_VALUE,1);
      light.spread = clamp(light.spread,0,1,1);
    }
    if (light.type === 'SphereLight' || light.type === 'SpotLight') light.radius = clamp(light.radius,0,Number.MAX_VALUE,light.type === 'SpotLight' ? .01 : 1);
    if (light.type === 'SpotLight') {
      light.outerAngle = clamp(light.outerAngle,Number.EPSILON,180,45);
      light.innerAngle = clamp(light.innerAngle,0,light.outerAngle,30);
    }
    if (invalid && !warnedLights.has(light)) {
      warnedLights.add(light);
      const error = new Error(`Invalid ${light.type} values were clamped.`);
      console.warn(error.message);
      onError?.(error);
    }
  }
}
