import { sceneParameters as prepareNativeScene } from './scene-core.js';
import { sceneCameraParameters as prepareSceneCamera } from './camera-core.js';
import { normalizeBounces } from '../src/renderer/pathLimits.js';
import { packCameraUniform } from '../src/renderer/cameraUniform.js';
import { buildBvh as buildBvhModule } from './bvh-core.js';
import { samplingParameters as buildSamplingParameters } from './sampling-core.js';

/** Experimental frame command: sample:f32, depth:i32, seed:u32, reserved:u32. */
export function frameParameters(sample: number, bounces: number, seed: number): Uint8Array {
  const data = new ArrayBuffer(16);
  new Float32Array(data)[0] = sample;
  new Int32Array(data)[1] = normalizeBounces(bounces);
  new Uint32Array(data)[2] = seed >>> 0;
  return new Uint8Array(data);
}

/** Translate a prepared camera in world space, preserving its lens/orientation. */
export function cameraParameters(bytes: Uint8Array, x: number, y: number, z: number): Uint8Array {
  const source = new Float32Array(bytes.buffer, bytes.byteOffset, 36);
  const inverse = new Float32Array(16);
  const world = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    const i = column * 4;
    inverse[i] = source[i] + x * source[i + 3];
    inverse[i + 1] = source[i + 1] + y * source[i + 3];
    inverse[i + 2] = source[i + 2] + z * source[i + 3];
    inverse[i + 3] = source[i + 3];
    world[i] = source[16 + i];
    world[i + 1] = source[17 + i];
    world[i + 2] = source[18 + i];
    world[i + 3] = source[19 + i];
  }
  world[12] += x; world[13] += y; world[14] += z;
  return new Uint8Array(packCameraUniform(inverse, world, source[32], source[33]).buffer);
}

/** Patch values only; the prepared scene supplies authoritative material offsets. */
export function materialParameters(r: number, g: number, b: number, roughness: number): Uint8Array {
  return new Uint8Array(new Float32Array([r, g, b, roughness]).buffer);
}


export function buildBvh(bytes: Uint8Array): Uint8Array { return buildBvhModule(bytes); }
export function samplingParameters(bytes: Uint8Array): Uint8Array { return buildSamplingParameters(bytes); }

export function sceneParameters(bytes: Uint8Array): Uint8Array { return prepareNativeScene(bytes); }

export function sceneCameraParameters(bytes: Uint8Array, width: number, height: number): Uint8Array {
  return prepareSceneCamera(bytes, width, height);
}

import {retainedSceneParameters as prepareRetained, releaseSceneParameters as releaseRetained,
  sceneMaterialParameters as prepareMaterial, sceneEnvironmentParameters as prepareEnvironment, sceneLightParameters as prepareLight, acceptSceneLighting as acceptLighting} from './scene-core.js';
export function retainedSceneParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareRetained(bytes, token); }
export function releaseSceneParameters(token: number): Uint8Array { return releaseRetained(token); }
export function sceneMaterialParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareMaterial(bytes, token); }

export function sceneEnvironmentParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareEnvironment(bytes, token); }

export function sceneLightParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareLight(bytes, token); }
export function acceptSceneLighting(token: number): Uint8Array { return acceptLighting(token); }

import {sceneTransformParameters as prepareTransform, acceptSceneTransform as acceptTransform} from './scene-core.js';
export function sceneTransformParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareTransform(bytes, token); }
export function acceptSceneTransform(token: number): Uint8Array { return acceptTransform(token); }

import {sceneGeometryParameters as prepareGeometry, acceptSceneGeometry as acceptGeometry} from './scene-core.js';
export function sceneGeometryParameters(bytes: Uint8Array, token: number): Uint8Array { return prepareGeometry(bytes, token); }
export function acceptSceneGeometry(token: number): Uint8Array { return acceptGeometry(token); }

import {nativeHardwareScene as hardwareScene, nativeSceneBegin as beginScene, nativeSceneBlas as sceneBlas, nativeSceneFinish as finishScene} from './scene-core.js';
export function nativeHardwareScene(bytes: Uint8Array, token: number): Uint8Array {return hardwareScene(bytes, token);}
export function nativeSceneBegin(bytes: Uint8Array, token: number): Uint8Array {return beginScene(bytes, token);}
export function nativeSceneBlas(bytes: Uint8Array, token: number): Uint8Array {return sceneBlas(bytes, token);}
export function nativeSceneFinish(bytes: Uint8Array, token: number): Uint8Array {return finishScene(bytes, token);}

import {nativeTransformBegin as beginTransform, nativeTransformFinish as finishTransform,
  nativeGeometryBegin as beginGeometry, nativeGeometryFinish as finishGeometry} from './scene-core.js';
export function nativeTransformBegin(bytes: Uint8Array, token: number): Uint8Array {return beginTransform(bytes,token);}
export function nativeTransformFinish(bytes: Uint8Array, token: number): Uint8Array {return finishTransform(bytes,token);}
export function nativeGeometryBegin(bytes: Uint8Array, token: number): Uint8Array {return beginGeometry(bytes,token);}
export function nativeGeometryFinish(bytes: Uint8Array, token: number): Uint8Array {return finishGeometry(bytes,token);}

import {configureSceneParameters as configureScene} from './scene-core.js';
export function configureSceneParameters(bytes: Uint8Array, token: number): Uint8Array { return configureScene(bytes, token); }

import {nativeShaderVariantStats} from './shader-variants.js';
export function shaderCacheParameters(): Uint8Array {
  const stats = nativeShaderVariantStats();
  return new Uint8Array(new Uint32Array([stats.generated, stats.hits, stats.retained, 0]).buffer);
}
