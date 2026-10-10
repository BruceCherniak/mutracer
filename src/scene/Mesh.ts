import Geometry from './Geometry';
import SceneNode from './SceneNode';
import OpenPBRMaterial from './OpenPBRMaterial';

/**
 * A geometry rendered with one or more materials. With several materials,
 * `geometry.materialIndex` selects the material of each triangle.
 */
export default class Mesh extends SceneNode {
  /** Materials supplied to the constructor, indexed by triangle materialIndex. */
  materials: OpenPBRMaterial[];
  /** Indexed triangle geometry supplied to the constructor; no default. */
  geometry: Geometry;
  /** Optional per-source-face OpenSubdiv dicing levels. */
  displacementFaceLevels?: Uint8Array;
  /** Stable hash used to separate camera-dependent tessellation cache entries. */
  displacementFaceLevelsHash = 0;
  /** Optional mesh-local ratio retained by geometry simplification. */
  geometrySimplificationRatio?: number;

  constructor(
    geometry: Geometry,
    material: OpenPBRMaterial[] | OpenPBRMaterial
  ) {
    super();

    this.geometry = geometry;
    this.materials = Array.isArray(material) ? material : [material];
  }

}
