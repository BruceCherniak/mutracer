import { describe, expect, it, vi } from 'vitest';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { mergeMeshesToGeometry } from '../../src/renderer/mergeMeshesToGeometry';
import { updateMeshInstances } from '../../src/renderer/prepareMeshBVH';
import { updatePreparedGeometries } from '../../src/renderer/geometryUpdates';
import { collectEmissiveTriangles } from '../../src/renderer/lightSampling';
import { generateCreasedVertexNormals } from '../../src/util/geometry';

function fixture() {
  const geometry = new Geometry({
    position: new Attribute(new Float32Array([0,0,0, 1,0,0, 0,1,0, 2,0,0, 3,0,0, 2,1,0]), 3),
    normal: new Attribute(new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1]), 3),
    indices: new Attribute(new Uint32Array([0,1,2,3,4,5]), 1),
    materialIndex: new Attribute(new Int32Array([0,0,0,1,1,1]), 1)
  });
  const a = new OpenPBRMaterial(), b = new OpenPBRMaterial();
  b.baseColor = [1,0,0]; b.emissionLuminance = 2;
  return new Mesh(geometry, [a,b]);
}
const packed = [255,0,0,0, 255,0,0,0, 255,0,0,0, 511,0,0,0, 511,0,0,0, 511,0,0,0];
describe('public material indices', () => {
  it('packs raw indices in both merge paths and subsequent topology updates', () => {
    const mesh = fixture();
    expect(Array.from(mergeMeshesToGeometry([mesh]).geometry.materialIndex!.array)).toEqual(packed);
    const prepared = updateMeshInstances([mesh]);
    expect(Array.from(prepared.geometry.materialIndex!.array)).toEqual(packed);
    mesh.geometry.materialIndex!.array.fill(1); mesh.geometry.markUpdated();
    updatePreparedGeometries(prepared, new Set([mesh.geometry]));
    for(let v=0;v<6;v++) expect(Array.from(prepared.geometry.materialIndex!.array.slice(v*4,v*4+4))).toEqual([511,0,0,0]);
    expect(collectEmissiveTriangles([{mesh,geometry:mesh.geometry,materialIndices:[0,1]}], mesh.materials)).toHaveLength(2);
  });
  it('selects the emissive triangle using its raw material index', () => {
    const mesh = fixture();
    const triangles = collectEmissiveTriangles([{mesh,geometry:mesh.geometry,materialIndices:[0,1]}], mesh.materials);
    expect(triangles).toHaveLength(1); expect(triangles[0].materialIndex).toBe(1);
  });
  it('falls back to the mesh first material and warns once across merge paths', () => {
    const mesh = fixture(); mesh.geometry.materialIndex!.array.fill(2);
    const warn = vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const prefix = fixture(); prefix.materials[0].baseColor = [0,1,0];
      const merged = mergeMeshesToGeometry([prefix,mesh]);
      expect(merged.geometry.materialIndex!.array[24] >> 8).toBe(2);
      updateMeshInstances([mesh]); mergeMeshesToGeometry([mesh]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });
  it('preserves raw indices when creasing duplicates vertices', () => {
    const mesh = fixture(); generateCreasedVertexNormals(mesh.geometry, 30);
    expect(mesh.geometry.materialIndex!.itemSize).toBe(1);
    expect(Array.from(mesh.geometry.materialIndex!.array)).toEqual([0,0,0,1,1,1]);
  });
});
