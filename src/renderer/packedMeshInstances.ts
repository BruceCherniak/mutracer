import { Box3 } from './Box3.js';
import { write } from '../math/access.js';
import type { TLASInstance } from './bvhAccel.js';

/** CPU instance records in numeric storage; one reusable synchronous read view. */
export class PackedMeshInstances {
  length = 0;
  readonly transforms: Float64Array;
  readonly colors: Float32Array;
  readonly bounds: Float32Array;
  readonly blasIndices: Uint32Array;
  readonly materials: Int32Array;
  readonly displacement: Float64Array;
  readonly sourceIndices: Uint32Array;
  bindingSlots: number[][] = [];
  readonly bindingIndices: Uint32Array;
  readonly localIndices: Uint32Array;
  private readonly view: TLASInstance = {blasIndex: 0, bounds: new Box3(), transform: new Array<number>(16).fill(0), materialsIndices: [0], color: [1,1,1]};
  constructor(capacity: number) {
    this.bindingIndices = new Uint32Array(capacity); this.localIndices = new Uint32Array(capacity);
    this.colors = new Float32Array(capacity * 3);
    this.transforms = new Float64Array(capacity * 16); this.bounds = new Float32Array(capacity * 6);
    this.blasIndices = new Uint32Array(capacity); this.materials = new Int32Array(capacity); this.displacement = new Float64Array(capacity); this.sourceIndices = new Uint32Array(capacity);
  }
  copy(): PackedMeshInstances {
    const next = new PackedMeshInstances(this.transforms.length / 16);
    next.length = this.length; next.bindingSlots = this.bindingSlots;
    next.transforms.set(this.transforms); next.bounds.set(this.bounds); next.colors.set(this.colors);
    next.blasIndices.set(this.blasIndices); next.materials.set(this.materials); next.displacement.set(this.displacement);
    next.sourceIndices.set(this.sourceIndices); next.bindingIndices.set(this.bindingIndices); next.localIndices.set(this.localIndices);
    return next;
  }
  read(index: number): TLASInstance {
    const v = this.view;
    v.blasIndex = this.blasIndices[index]; v.materialsIndices[0] = this.materials[index]; v.displacementScale = this.displacement[index];
    for (let i = 0; i < 16; i++) write(v.transform, i, this.transforms[index * 16 + i]);
    // Tuple-to-array conversion uses different native storage; update the tuple directly.
    const color = v.color!;
    color[0] = this.colors[index * 3];
    color[1] = this.colors[index * 3 + 1];
    color[2] = this.colors[index * 3 + 2];
    for (let i = 0; i < 3; i++) {write(v.bounds.min, i, this.bounds[index * 6 + i]); write(v.bounds.max, i, this.bounds[index * 6 + i + 3]);}
    return v;
  }
}
export type MeshInstances = TLASInstance[] | PackedMeshInstances;
export function readMeshInstance(instances: MeshInstances, index: number) {
  return Array.isArray(instances) ? instances[index] : instances.read(index);
}

export function sameInstanceMembership(a: MeshInstances, b: MeshInstances) {
  if (meshInstancesLength(a) !== meshInstancesLength(b)) return false;
  if (!Array.isArray(a) && !Array.isArray(b)) {
    for (let i = 0; i < a.length; i++) if (a.sourceIndices[i] !== b.sourceIndices[i]) return false;
  }
  return true;
}

export function meshInstancesLength(instances: MeshInstances): number {
  if (Array.isArray(instances)) return instances.length;
  return instances.length;
}
