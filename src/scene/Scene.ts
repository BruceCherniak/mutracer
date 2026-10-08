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
  type: 'GroundedSkybox';
  map: Texture;
  /** Height of the camera used to capture the environment above the ground. */
  height: number;
  /** Radius of the projected sky dome. */
  radius: number;
  /** World-space Y coordinate of the ground plane. */
  groundHeight?: number;
  /** World-space X/Z center of the environment capture. */
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
  data: Uint8Array;
  width: number;
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
  meshes: Mesh[];
  lights: SceneLight[];
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
