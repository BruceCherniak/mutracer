import Mesh from '../scene/Mesh.js';
import InstancedMesh from '../scene/InstancedMesh.js';
import { mat4 } from '../math.js';
import type { TLASInstance } from './bvhAccel.js';

export function meshInstanceCount(mesh: Mesh) { return mesh instanceof InstancedMesh ? mesh.count : 1; }
/** Writes a world matrix without allocating per-instance Mesh objects or views. */
export function meshInstanceTransform(mesh: Mesh, index: number, out: mat4.Mat4Array): mat4.Mat4Array {
  if (!(mesh instanceof InstancedMesh)) return mat4.copy(out, mesh.transform);
  const local = mesh.transforms, offset = index * 16, parent = mesh.transform;
  for (let column = 0; column < 4; column++) {
    const o = offset + column * 4;
    const x = local[o], y = local[o + 1], z = local[o + 2], w = local[o + 3];
    for (let row = 0; row < 4; row++) out[column * 4 + row] = parent[row] * x + parent[row + 4] * y + parent[row + 8] * z + parent[row + 12] * w;
  }
  return out;
}

/** CPU instance records in numeric storage; one reusable synchronous read view. */
export class PackedMeshInstances {
  length = 0;
  readonly transforms: Float64Array;
  readonly bounds: Float32Array;
  readonly blasIndices: Uint32Array;
  readonly materials: Int32Array;
  readonly displacement: Float64Array;
  readonly sourceIndices: Uint32Array;
  private readonly view: TLASInstance = {blasIndex: 0, bounds: {min: [0,0,0], max: [0,0,0]}, transform: Array(16).fill(0), materialsIndices: [0]};
  constructor(capacity: number) {
    this.transforms = new Float64Array(capacity * 16); this.bounds = new Float32Array(capacity * 6);
    this.blasIndices = new Uint32Array(capacity); this.materials = new Int32Array(capacity); this.displacement = new Float64Array(capacity); this.sourceIndices = new Uint32Array(capacity);
  }
  read(index: number): TLASInstance {
    const v = this.view;
    v.blasIndex = this.blasIndices[index]; v.materialsIndices[0] = this.materials[index]; v.displacementScale = this.displacement[index];
    for (let i = 0; i < 16; i++) v.transform[i] = this.transforms[index * 16 + i];
    for (let i = 0; i < 3; i++) {v.bounds.min[i] = this.bounds[index * 6 + i]; v.bounds.max[i] = this.bounds[index * 6 + i + 3];}
    return v;
  }
}
export type MeshInstances = TLASInstance[] | PackedMeshInstances;
export function readMeshInstance(instances: MeshInstances, index: number) {
  return instances instanceof PackedMeshInstances ? instances.read(index) : instances[index];
}

export function sameInstanceMembership(a: MeshInstances, b: MeshInstances) {
  if (a.length !== b.length) return false;
  if (a instanceof PackedMeshInstances && b instanceof PackedMeshInstances) {
    for (let i = 0; i < a.length; i++) if (a.sourceIndices[i] !== b.sourceIndices[i]) return false;
  }
  return true;
}
