import Geometry from './Geometry.js';
import SceneNode from './SceneNode.js';
import OpenPBRMaterial from './OpenPBRMaterial.js';

/**
 * A geometry rendered with one or more materials. With several materials,
 * `geometry.materialIndex` selects the material of each triangle.
 */
export default class Mesh extends SceneNode {
  /** Materials supplied to the constructor, indexed by triangle materialIndex. */
  materials: OpenPBRMaterial[];
  /** Indexed triangle geometry supplied to the constructor; no default. */
  geometry: Geometry;

  constructor(
    geometry: Geometry,
    material: OpenPBRMaterial[] | OpenPBRMaterial
  ) {
    super();

    this.geometry = geometry;
    this.materials = Array.isArray(material) ? material : [material];
  }

}
