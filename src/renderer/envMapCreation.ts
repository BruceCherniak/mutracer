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
import type { SceneBackground } from '../scene/Scene.js';
import type { EnvironmentMapSource } from './envMapDistribution.js';

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
    if (!isTextureDataSource(texture.image)) return;
    // Is rgbe data
    backgroundImage = {
      width: texture.image.width,
      height: texture.image.height,
      data: texture.image.data
    };
  }
  return backgroundImage;
}

export function generateEnvMapFromSceneComponents(
  ambientLights: AmbientLight[],
  environmentLights: EnvironmentLight[]
) {
  let envImage = initializeEnvMap(environmentLights);
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

export function initializeEnvMap(environmentLights: EnvironmentLight[]) {
  let envImage: EnvironmentMapSource;

  // Initialize map from environment light if present
  if (environmentLights.length > 0) {
    // TODO: support multiple environment lights (what if they have different resolutions?)
    const environmentLight = environmentLights[0];
    envImage = {
      width: environmentLight.map.image.width,
      height: environmentLight.map.image.height,
      data: (environmentLight.map.image as TextureDataSource).data,
      distributionCacheKey:
        environmentLight.map.source ??
        (environmentLight.map.image as TextureDataSource).data,
      distributionCacheVersion: environmentLight.map.version
    };
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
