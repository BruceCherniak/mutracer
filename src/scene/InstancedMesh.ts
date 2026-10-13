import Mesh from './Mesh.js';
import Geometry from './Geometry.js';
import OpenPBRMaterial from './OpenPBRMaterial.js';

/** Options for a batch sharing geometry and materials. */
export interface InstancedMeshOptions {
  /** Required active instance count; a nonnegative integer. */
  count: number;
  /** Column-major local matrices, at least 16 * count floats. Default: count identity matrices. The array is retained. */
  transforms?: Float32Array;
}

/** A batch of instances. World matrices are transform * transforms[i]. */
export default class InstancedMesh extends Mesh {
  /** Local column-major matrices. Default: count identities. Call markTransformsUpdated after element edits. */
  transforms: Float32Array;
  /** Active prefix length. Default: constructor count; must fit transforms. Changes are detected by engine.update. */
  count: number;
  /** Transform notification version. Default 0; advanced by markTransformsUpdated. */
  get version(): number { return this._transformVersion; }
  private _transformVersion = 0;

  constructor(geometry: Geometry, material: OpenPBRMaterial | OpenPBRMaterial[], options: InstancedMeshOptions) {
    super(geometry, material);
    this.count = options.count;
    this.transforms = options.transforms ?? new Float32Array(this.count * 16);
    this.validate();
    if (!options.transforms) for (let i = 0; i < this.count; i++) {
      const offset = i * 16;
      this.transforms[offset] = this.transforms[offset + 5] = this.transforms[offset + 10] = this.transforms[offset + 15] = 1;
    }
  }
  /** Notify edited local matrices. Defaults: start 0, count all active matrices from start. Returns this. */
  markTransformsUpdated(start = 0, count = this.count - start): this {
    this.validate();
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > this.count) {
      throw new RangeError('Instance transform range must fit the active count.');
    }
    this._transformVersion++;
    return this;
  }
  /** @internal */
  validate() {
    if (!Number.isInteger(this.count) || this.count < 0 || !(this.transforms instanceof Float32Array) || this.transforms.length < this.count * 16) {
      throw new RangeError('InstancedMesh requires a nonnegative count and at least 16 * count Float32 transforms.');
    }
  }
}
