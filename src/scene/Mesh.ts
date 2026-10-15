import MeshState from './MeshState.js';
import type Geometry from './Geometry.js';
import type OpenPBRMaterial from './OpenPBRMaterial.js';

/**
 * A geometry rendered with one or more materials. With several materials,
 * `geometry.materialIndex` selects the material of each triangle.
 */
export default class Mesh extends MeshState {
  /** Materials supplied to the constructor, indexed by per-vertex materialIndex. */
  declare materials: OpenPBRMaterial[];
  constructor(geometry: Geometry, material: OpenPBRMaterial[] | OpenPBRMaterial) { super(geometry, material); }
}
