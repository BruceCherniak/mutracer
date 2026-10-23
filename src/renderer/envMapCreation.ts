// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

// Convert image data from the RGBE format to a 32-bit floating point format
// See https://www.cg.tuwien.ac.at/research/theses/matkovic/node84.html for a description of the RGBE format

import type { ColorRGBA, WritableArrayLike } from '../types.js';
import Texture, {
  isTextureDataSource,
  type TextureDataSource
} from '../scene/Texture.js';
import AmbientLight from '../scene/AmbientLight.js';
import EnvironmentLight from '../scene/EnvironmentLight.js';
import type { SceneBackground, SceneLight } from '../scene/Scene.js';
import { isProceduralSkyImage } from '../scene/skyParameters.js';
import type { EnvironmentSource, EnvironmentMapSource, ProceduralEnvironmentSource } from './envMapDistribution.js';

/** Rotation only: translation does not affect a light at infinity. */
export function environmentRotation(lights: readonly SceneLight[]): Float32Array {
  const matrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  const light = lights.find(light => light.type === 'EnvironmentLight');
  if (light?.type === 'EnvironmentLight') {
    for (let column = 0; column < 3; column++) {
      const offset = column * 4;
      const length = Math.hypot(light.transform[offset], light.transform[offset+1], light.transform[offset+2]);
      if (length > 0) for (let row = 0; row < 3; row++) matrix[offset+row] = light.transform[offset+row] / length;
    }
  }
  return matrix;
}

/** Cosine/sine of inverse-lookup yaw and radiance scale; independent of lighting. */
export function backgroundMapTransform(background?: SceneBackground): Float32Array {
  const grounded = background && !Array.isArray(background) && 'type' in background && background.type === 'GroundedSkybox' ? background : undefined;
  const angle = grounded?.rotation ?? 0;
  return new Float32Array([Math.cos(angle), Math.sin(angle), Math.max(0, grounded?.intensity ?? 1), 0]);
}

const backgroundImages = new WeakMap<Texture, {image: Texture['image']; version: number; result: EnvironmentSource}>();

const DEFAULT_MAP_RESOLUTION = {
  width: 8,
  height: 4
};

// Tools for generating and modify env maps for lighting from scene component data

export function generateBackgroundMapFromSceneBackground(
  background: SceneBackground
) {
  let backgroundImage;

  // Is [r,g,b,a] color
  if (Array.isArray(background)) {
    backgroundImage = generateSolidMap(1, 1, background);
  } else {
    const texture: Texture =
      'map' in background ? background.map : (background as Texture);
    const cached = backgroundImages.get(texture);
    if (cached?.image === texture.image && cached.version === texture.version) return cached.result;
    if (isProceduralSkyImage(texture.image)) backgroundImage = skySource(texture.image, 1);
    else if (isTextureDataSource(texture.image)) backgroundImage = {width: texture.image.width, height: texture.image.height, data: texture.image.data};
    else return;
    backgroundImages.set(texture, {image:texture.image, version:texture.version, result:backgroundImage});
  }
  return backgroundImage;
}

export function generateEnvMapFromSceneComponents(
  ambientLights: AmbientLight[],
  environmentLights: EnvironmentLight[]
) {
  let envImage = initializeEnvMap(environmentLights);
  if ('sky' in envImage) {
    for (const light of ambientLights) for (let c = 0; c < 3; c++) envImage.ambient[c] += light.color[c] * light.intensity;
    return envImage;
  }
  if (ambientLights.length > 0 && environmentLights.length > 0) {
    envImage = {
      width: envImage.width,
      height: envImage.height,
      data: envImage.data.slice() as TextureDataSource['data']
    };
  }
  ambientLights.forEach((light) => {
    addAmbientLightToEnvMap(light, envImage);
  });

  return envImage;
}

const scaledEnvironments = new WeakMap<EnvironmentLight, {
  data: TextureDataSource['data']; width: number; height: number; version: number;
  intensity: number; image: EnvironmentMapSource;
}>();

export function initializeEnvMap(environmentLights: EnvironmentLight[]): EnvironmentSource {
  let envImage: EnvironmentMapSource;

  // Initialize map from environment light if present
  if (environmentLights.length > 0) {
    // TODO: support multiple environment lights (what if they have different resolutions?)
    const environmentLight = environmentLights[0];
    if (isProceduralSkyImage(environmentLight.map.image)) {
      const intensity = Number.isFinite(environmentLight.intensity) ? Math.max(0, environmentLight.intensity) : 1;
      return skySource(environmentLight.map.image, intensity);
    }
    envImage = {
      width: environmentLight.map.image.width,
      height: environmentLight.map.image.height,
      data: (environmentLight.map.image as TextureDataSource).data,
      distributionCacheKey:
        environmentLight.map.source ??
        (environmentLight.map.image as TextureDataSource).data,
      distributionCacheVersion: environmentLight.map.version
    };
    const intensity = Number.isFinite(environmentLight.intensity) ? Math.max(0, environmentLight.intensity) : 1;
    if (intensity !== 1 || !(envImage.data instanceof Float32Array)) {
      const previous = scaledEnvironments.get(environmentLight);
      if (previous && previous.data === envImage.data && previous.width === envImage.width &&
        previous.height === envImage.height && previous.version === environmentLight.map.version && previous.intensity === intensity) {
        return previous.image;
      }
      const scale = envImage.data instanceof Uint8Array || envImage.data instanceof Uint8ClampedArray ? 1 / 255 : 1;
      const data = Float32Array.from(envImage.data, (value, index) => value * scale * (index % 4 === 3 ? 1 : intensity));
      const image = {width: envImage.width, height: envImage.height, data};
      scaledEnvironments.set(environmentLight, {data: envImage.data, width: envImage.width, height: envImage.height,
        version: environmentLight.map.version, intensity, image});
      envImage = image;
    }
  } else {
    // initialize blank map
    envImage = generateSolidMap(
      DEFAULT_MAP_RESOLUTION.width,
      DEFAULT_MAP_RESOLUTION.height,
      [0, 0, 0, 1]
    );
  }

  return envImage;
}

export function generateSolidMap(
  width: number,
  height: number,
  color?: ColorRGBA,
  intensity?: number
): TextureDataSource {
  const texels = width * height;
  const floatBuffer = new Float32Array(texels * 4);
  if (color && Array.isArray(color)) {
    setBufferToColor(floatBuffer, color, intensity);
  }
  return {
    width: width,
    height: height,
    data: floatBuffer
  };
}

function setBufferToColor(
  buffer: WritableArrayLike<number>,
  color: ColorRGBA,
  intensity = 1
) {
  for (let i = 0; i < buffer.length; ) {
    buffer[i++] = color[0] * intensity;
    buffer[i++] = color[1] * intensity;
    buffer[i++] = color[2] * intensity;
    buffer[i++] = color[3];
  }

  return buffer;
}

function addAmbientLightToEnvMap(
  light: AmbientLight,
  image: TextureDataSource
) {
  const color = light.color;
  const intensity = light.intensity;
  const buffer = image.data;

  for (let i = 0; i < buffer.length; ) {
    buffer[i++] += color[0] * intensity;
    buffer[i++] += color[1] * intensity;
    buffer[i++] += color[2] * intensity;
    i++;
  }
}

function skySource(sky: import('../scene/skyParameters.js').ProceduralSkyImage, intensity: number): ProceduralEnvironmentSource {
  return { sky, width: sky.width, height: sky.height, intensity, ambient: [0, 0, 0] };
}
