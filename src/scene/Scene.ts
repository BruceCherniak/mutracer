import { ColorRGBA } from '../types.js';
import AmbientLight from './AmbientLight.js';
import DirectionalLight from './DirectionalLight.js';
import EnvironmentLight from './EnvironmentLight.js';
import Mesh from './Mesh.js';
import InstancedMesh from './InstancedMesh.js';
import RectLight from './RectLight.js';
import SphereLight from './SphereLight.js';
import SpotLight from './SpotLight.js';
import Texture from './Texture.js';

/** Lights with an analytic shape. */
export type AnalyticLight = RectLight | SphereLight | SpotLight | DirectionalLight;
/** Any light that can be placed in {@link Scene.lights}. */
export type SceneLight = AmbientLight | EnvironmentLight | AnalyticLight;

/**
 * Environment map projected onto a ground plane and sky dome, so objects
 * appear to stand on the photographed ground.
 */
export interface GroundedSkyboxBackground {
  /** Ground projection discriminator; always `GroundedSkybox`. */
  type: 'GroundedSkybox';
  /** Required equirectangular environment texture. */
  map: Texture;
  /** Required capture height above ground in scene units. */
  height: number;
  /** Required projected sky-dome radius in scene units. */
  radius: number;
  /** Ground plane Y in scene units. Default `0`. */
  groundHeight?: number;
  /** Capture X/Z center in scene units. Default `[0, 0]`. */
  center?: [number, number];
}

/**
 * What camera rays that miss the scene show: a linear RGBA color (alpha 0
 * for a transparent canvas), an equirectangular texture, or a grounded
 * skybox. When omitted, the environment light is shown.
 */
export type SceneBackground = ColorRGBA | Texture | GroundedSkyboxBackground;
/**
 * Everything the renderer draws. A plain object; mesh and light membership,
 * mesh transforms, material parameters, resource references, light parameters and background
 * values are detected automatically, including edits within existing arrays.
 * Call `markUpdated()` on a Geometry after attribute edits, and a Texture
 * after pixel or UV-array element edits.
 * InstancedMesh matrix elements require markTransformsUpdated().
 */
export interface Scene {
  /** Required mesh instances; use an empty array for an empty scene. */
  meshes: (Mesh | InstancedMesh)[];
  /** Required lights; use an empty array for an unlit scene. */
  lights: SceneLight[];
  /** Camera-ray background; defaults to the environment light when omitted. */
  background?: SceneBackground;

}
