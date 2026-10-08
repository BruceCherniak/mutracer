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

it('packs mesh projection overrides without duplicating shared material slots', async () => {
  const { createCubeGeometry } = await import('../../src/util/commonGeometry');
  const { flattenBvh, buildTLAS, INSTANCE_WORD_STRIDE, refitTLAS } = await import('../../src/renderer/bvhAccel');
  const material = new OpenPBRMaterial(); const geo = createCubeGeometry();
  const a = new Mesh(geo,material), b = new Mesh(geo,material);
  b.uvProjection='triplanar'; b.displacementUvProjection='spherical';
  const prepared = updateMeshInstances([a,b]);
  expect(prepared.materials).toEqual([material]);
  const packed = flattenBvh(buildTLAS(prepared.instances,prepared.blases),true);
  const data = new Float32Array(packed.instancesBuffer!).slice();
  const projections = [Array.from(data.slice(36,38)), Array.from(data.slice(INSTANCE_WORD_STRIDE+36,INSTANCE_WORD_STRIDE+38))];
  expect(projections).toEqual(expect.arrayContaining([[-1,-1],[3,1]]));
  refitTLAS(packed,prepared.instances,prepared.blases);
  expect(Array.from(new Float32Array(packed.instancesBuffer!))).toEqual(Array.from(data));
});

it('separates projective displacement BLAS caches for different mesh projections', async () => {
  const { createCubeGeometry } = await import('../../src/util/commonGeometry');
  const { getPreparedMeshGeometry, getMeshDisplacementTessellationOptions } = await import('../../src/renderer/prepareMeshBVH');
  const { default: Texture } = await import('../../src/scene/Texture');
  const material = new OpenPBRMaterial(); material.displacementMap = new Texture({data: new Uint8Array(16),width:2,height:2}); material.displacementScale=0.1;
  const geo=createCubeGeometry(); const a=new Mesh(geo,material), b=new Mesh(geo,material);
  a.displacementUvProjection='triplanar'; b.displacementUvProjection='spherical';
  const ga=getPreparedMeshGeometry(a), gb=getPreparedMeshGeometry(b);
  expect(ga).not.toBe(gb); expect(ga.position).toBe(geo.position);
  expect(getPreparedMeshGeometry(a)).toBe(ga);
  expect(getMeshDisplacementTessellationOptions(a).uvProjection).toBe('triplanar');
  expect(material.displacementUvProjection).toBe('none');
});
