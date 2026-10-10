import { ColorRGBA } from '../types';
import AmbientLight from './AmbientLight';
import DirectionalLight from './DirectionalLight';
import EnvironmentLight from './EnvironmentLight';
import Mesh from './Mesh';
import RectLight from './RectLight';
import SphereLight from './SphereLight';
import SpotLight from './SpotLight';
import Texture from './Texture';

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
/** RGBA8 pixels for {@link Scene.overlay}. */
export interface SceneOverlayDataSource {
  /** Required RGBA8 overlay pixels in row-major order. */
  data: Uint8Array;
  /** Required overlay pixel width. */
  width: number;
  /** Required overlay pixel height. */
  height: number;
}
/**
 * Everything the renderer draws. A plain object; mesh and light membership,
 * mesh transforms, resource references, light parameters and background
 * values are detected automatically, including edits within existing arrays.
 * Call `markUpdated()` on a material after parameter edits, a Geometry after
 * attribute edits, and a Texture after pixel or UV-array element edits.
 */
export interface Scene {
  /** Required mesh instances; use an empty array for an empty scene. */
  meshes: Mesh[];
  /** Required lights; use an empty array for an unlit scene. */
  lights: SceneLight[];
  /** Camera-ray background; defaults to the environment light when omitted. */
  background?: SceneBackground;

  /** Image composited over the final frame, in canvas pixels. */
  overlay?: {
    image: HTMLImageElement | HTMLCanvasElement | SceneOverlayDataSource;
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
