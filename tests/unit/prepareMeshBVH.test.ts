import { describe, expect, it } from 'vitest';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Texture from '../../src/scene/Texture';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {
  getTrianglesDisplacementRange,
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

it('packs material variants in 144-byte instances and retains material slots during refit', async () => {
  const { createCubeGeometry } = await import('../../src/util/commonGeometry');
  const { buildTLAS, INSTANCE_VEC4_STRIDE, INSTANCE_WORD_STRIDE, refitTLAS } = await import('../../src/renderer/bvhAccel');
  const material = new OpenPBRMaterial(), variant = new OpenPBRMaterial();
  variant.uvProjection = 'triplanar'; variant.displacementUvProjection = 'spherical';
  const geo = createCubeGeometry(), a = new Mesh(geo, material), b = new Mesh(geo, variant);
  b.matrixWorld[12] = 2;
  const prepared = updateMeshInstances([a, b]);
  expect(prepared.materials).toEqual([material, variant]);
  expect(prepared.instanceBindings.map(binding => binding.materialIndices)).toEqual([[0], [1]]);
  const packed = buildTLAS(prepared.instances, prepared.blases);
  expect(INSTANCE_VEC4_STRIDE).toBe(9); expect(INSTANCE_WORD_STRIDE).toBe(36);
  expect(packed.instancesBuffer!.byteLength).toBe(2 * 144);
  const data = new Uint32Array(packed.instancesBuffer!).slice();
  refitTLAS(packed, prepared.instances, prepared.blases);
  expect(new Uint32Array(packed.instancesBuffer!)).toEqual(data);
});

it('separates projective displacement BLAS caches for different material projections', async () => {
  const { createCubeGeometry } = await import('../../src/util/commonGeometry');
  const { getPreparedMeshGeometry } = await import('../../src/renderer/prepareMeshBVH');
  const { default: Texture } = await import('../../src/scene/Texture');
  const material = new OpenPBRMaterial();
  material.displacementMap = new Texture({ data: new Uint8Array(16), width: 2, height: 2 }); material.displacementScale = .1;
  const triplanar = Object.assign(new OpenPBRMaterial(), material, { displacementUvProjection: 'triplanar' as const });
  const spherical = Object.assign(new OpenPBRMaterial(), material, { displacementUvProjection: 'spherical' as const });
  const geo = createCubeGeometry(), a = new Mesh(geo, triplanar), b = new Mesh(geo, spherical);
  const ga = getPreparedMeshGeometry(a), gb = getPreparedMeshGeometry(b);
  expect(ga).not.toBe(gb); expect(ga.position).toBe(geo.position);
  expect(getPreparedMeshGeometry(a)).toBe(ga);
  expect(material.displacementUvProjection).toBe('none');
});

it('supports projective range bounds without UVs when using triplanar projection', () => {
  const geometry = triangleGeometry();
  geometry.uv = undefined;
  const material = new OpenPBRMaterial();
  material.displacementUvProjection = 'triplanar';
  const range = getTrianglesDisplacementRange(
    geometry,
    heightTexture([0, 0.25, 0.5, 1], 2),
    material
  );

  expect(range).toBeInstanceOf(Float32Array);
  expect(range).toHaveLength(2);
});

it('supports projective range bounds without UVs when using cylindrical projection', () => {
  const geometry = triangleGeometry();
  geometry.uv = undefined;
  const material = new OpenPBRMaterial();
  material.displacementUvProjection = 'cylindrical';
  material.displacementUvScale = 2;
  const range = getTrianglesDisplacementRange(
    geometry,
    heightTexture([0, 0.25, 0.5, 1], 2),
    material
  );

  expect(range).toBeInstanceOf(Float32Array);
  expect(range).toHaveLength(2);
});
function triangleGeometry() {
  return new Geometry({
    position: new Attribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    normal: new Attribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
    uv: new Attribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2),
    indices: new Attribute(new Uint32Array([0, 1, 2]), 1)
  });
}

function heightTexture(values: number[], width: number, height = width) {
  return new Texture({ data: new Float32Array(values), width, height });
}
