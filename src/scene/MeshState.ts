import Geometry from './Geometry.js';
import SceneNode from './SceneNode.js';
import type MaterialState from './MaterialState.js';
import type InstanceState from './InstanceState.js';
export interface InstanceData { count: number; transforms: Float32Array; colors: Float32Array | undefined; transformsVersion: number; colorsVersion: number; }

/**
 * A geometry rendered with one or more materials. With several materials,
 * `geometry.materialIndex` selects the material of each triangle.
 */
export default class MeshState extends SceneNode {
  /** Materials supplied to the constructor, indexed by per-vertex materialIndex. */
  materials: MaterialState[];
  /** Indexed triangle geometry supplied to the constructor; no default. */
  geometry: Geometry;

  /** @internal */
  private _instances?: InstanceState;
  /** @internal */
  get instanceData(): InstanceData | undefined {
    const state = this._instances;
    return state ? {count: state.count, transforms: state.transforms, colors: state.colors,
      transformsVersion: state.transformsVersion, colorsVersion: state.colorsVersion} : undefined;
  }
  /** @internal */
  setInstanceState(state: InstanceState | undefined) { this._instances = state; }

  constructor(
    geometry: Geometry,
    material: MaterialState[] | MaterialState
  ) {
    super();

    this.geometry = geometry;
    this.materials = Array.isArray(material) ? material : [material];
  }

}
