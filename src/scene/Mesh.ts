import Geometry from './Geometry';
import SceneNode from './SceneNode';
import OpenPBRMaterial from './OpenPBRMaterial';

/**
 * A geometry rendered with one or more materials. With several materials,
 * `geometry.materialIndex` selects the material of each triangle.
 */
export default class Mesh extends SceneNode {
  materials: OpenPBRMaterial[];
  geometry: Geometry;
  /** Mesh-local texture projection override. Default: inherit the material. */
  uvProjection?: OpenPBRMaterial['uvProjection'];
  /** Mesh-local displacement and bump projection override. Default: inherit the material. */
  displacementUvProjection?: OpenPBRMaterial['displacementUvProjection'];
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
