import { describe, expect, it } from 'vitest';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {
  
  updateMeshInstances
} from '../../src/renderer/prepareMeshBVH';

describe('merged renderer geometry', () => {
  it('retains every triangle when distinct meshes are prepared together', () => {
    const triangle = (x: number) => new Mesh(new Geometry({
      position: new Attribute(new Float32Array([
        x, 0, 0, x + 1, 0, 0, x, 1, 0
      ]), 3),
      normal: new Attribute(new Float32Array([
        0, 0, 1, 0, 0, 1, 0, 0, 1
      ]), 3),
      indices: new Attribute(new Uint32Array([0, 1, 2]), 1)
    }), new OpenPBRMaterial());
    const prepared = updateMeshInstances([triangle(0), triangle(2)]);
    expect(Array.from(prepared.geometry.indices.array)).toEqual([
      0, 1, 2, 3, 4, 5
    ]);
  });
});

it('assigns material slots by identity and retains them after parameter edits', () => {
  const a = new OpenPBRMaterial();
  const b = new OpenPBRMaterial();
  const geometry = new Geometry({
    position: new Attribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]), 3),
    indices: new Attribute(new Uint32Array([0,1,2]), 1)
  });
  const meshes = [new Mesh(geometry, a), new Mesh(geometry, b), new Mesh(geometry, a)];
  const before = updateMeshInstances(meshes);
  expect(before.materials).toEqual([a,b]);
  expect(before.instanceBindings.map(b => b.materialIndices)).toEqual([[0],[1],[0]]);
  a.specularRoughness = 0.7;
  a.markUpdated();
  expect(updateMeshInstances(meshes).instanceBindings.map(b => b.materialIndices)).toEqual([[0],[1],[0]]);
});
