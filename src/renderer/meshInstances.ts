import {matrixStorage} from '../math/storage.js';
import type MeshState from '../scene/MeshState.js';
import { read, write } from '../math/access.js';
import { mat4 } from '../math.js';

export function meshInstanceCount(mesh: MeshState) { return mesh.instanceData?.count ?? 1; }
/** Writes a world matrix without allocating per-instance Mesh objects or views. */
export function meshInstanceTransform<T extends mat4.Mat4Array>(mesh: MeshState, index: number, out: T, parent = matrixStorage(mesh.transform)): T {
  const instances = mesh.instanceData;
  if (!instances) return mat4.copy(out, parent);
  const local = instances.transforms, offset = index * 16;
  for (let column = 0; column < 4; column++) {
    const o = offset + column * 4;
    const x = local[o], y = local[o + 1], z = local[o + 2], w = local[o + 3];
    for (let row = 0; row < 4; row++) write(out, column * 4 + row, read(parent, row) * x + read(parent, row + 4) * y + read(parent, row + 8) * z + read(parent, row + 12) * w);
  }
  return out;
}

export { PackedMeshInstances, readMeshInstance, sameInstanceMembership, type MeshInstances } from './packedMeshInstances.js';
