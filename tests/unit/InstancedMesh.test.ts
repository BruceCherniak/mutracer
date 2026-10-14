import {expect, it, vi} from 'vitest';
import InstancedMesh from '../../src/scene/InstancedMesh';
import Mesh from '../../src/scene/Mesh';
import Geometry, {Attribute} from '../../src/scene/Geometry';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createCubeGeometry, createPlaneGeometry} from '../../src/util/commonGeometry';
import {renderFixture} from '../helpers/renderPipeline';
import {updateMeshInstances, updateMeshInstanceTransforms} from '../../src/renderer/prepareMeshBVH';
import {PackedMeshInstances, meshInstanceTransform, readMeshInstance, sameInstanceMembership} from '../../src/renderer/meshInstances';
import {buildTLAS, refitTLAS} from '../../src/renderer/bvhAccel';
import {MeshMembershipCache} from '../../src/renderer/meshMembership';
import {collectEmissiveTriangles, EmissiveTriangleCache} from '../../src/renderer/lightSampling';
import {mergeMeshesToGeometry} from '../../src/renderer/mergeMeshesToGeometry';

const material = () => new OpenPBRMaterial({baseColor: [.3,.5,.7]});
function batch(count = 3) {
  const mesh = new InstancedMesh(createCubeGeometry(), material(), {count});
  for (let i = 0; i < count; i++) mesh.transforms[i * 16 + 12] = i * 3;
  mesh.transform = Array.from(mesh.transform); mesh.transform[12] = .123456789123;
  return mesh;
}
function expanded(mesh: InstancedMesh) {
  return Array.from({length: mesh.count}, (_, i) => {
    const single = new Mesh(mesh.geometry, mesh.materials);
    single.transform = meshInstanceTransform(mesh, i, Array(16).fill(0)); return single;
  });
}
it('initializes identities, retains storage and validates notification ranges/counts', () => {
  const mesh = batch();
  expect([...mesh.transforms.slice(0,16)]).toEqual([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  const supplied = new Float32Array(mesh.transforms);
  expect(new InstancedMesh(mesh.geometry, mesh.materials, {count: 2, transforms: supplied}).transforms).toBe(supplied);
  expect(mesh.markTransformsUpdated(1,1)).toBe(mesh); expect(mesh.version).toBe(1);
  expect(() => mesh.markTransformsUpdated(-1)).toThrow(RangeError);
  expect(() => mesh.markTransformsUpdated(2,2)).toThrow(RangeError);
  expect(() => new InstancedMesh(mesh.geometry, mesh.materials, {count: 3, transforms: new Float32Array(32)})).toThrow(RangeError);
  expect(() => new InstancedMesh(mesh.geometry, mesh.materials, {count: 1.5})).toThrow(RangeError);
});
it('commits notified matrices once, isolates edits and keeps snapshots stable during unrelated commits', () => {
  const {engine, pipeline} = renderFixture(); const mesh = batch();
  engine.scene = {meshes: [mesh], lights: []}; engine.update();
  const committed = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0][0] as InstancedMesh;
  expect(committed).toBeInstanceOf(InstancedMesh); expect(committed.transforms).not.toBe(mesh.transforms);
  const storage = committed.transforms, set = vi.spyOn(storage, 'set');
  mesh.transforms[28] = 8;
  expect(engine.update()).toBe(false); expect(storage[28]).toBe(3); expect(set).not.toHaveBeenCalled();
  mesh.materials[0].baseColor = [.8,.1,.2];  engine.update();
  expect(storage[28]).toBe(3); expect(set).not.toHaveBeenCalled();
  mesh.markTransformsUpdated(1,1); expect(engine.update()).toBe(true);
  expect(committed.transforms).toBe(storage); expect(storage[28]).toBe(8); expect(set).toHaveBeenCalledOnce();
  expect(engine.update()).toBe(false);
  // Full membership capture must also leave unnotified instance elements alone.
  mesh.transforms[28] = 9; engine.scene.meshes.push(new Mesh(mesh.geometry, mesh.materials)); engine.update();
  expect(storage[28]).toBe(8); expect(set).toHaveBeenCalledOnce();
  mesh.count = 2; expect(engine.update()).toBe(true); expect(committed.count).toBe(2);
  mesh.count = 4; expect(() => engine.update()).toThrow(RangeError);
  engine.dispose();
});
it('stores one binding per batch and produces exactly the expanded TLAS and flattened geometry', () => {
  const mesh = batch(7), singles = expanded(mesh);
  const packed = updateMeshInstances([mesh]), reference = updateMeshInstances(singles);
  expect(packed.instances).toBeInstanceOf(PackedMeshInstances); expect(packed.instanceBindings).toHaveLength(1);
  expect(packed.geometries).toHaveLength(1); expect(packed.instances.length).toBe(7);
  const a = buildTLAS(packed.instances, packed.blases), b = buildTLAS(reference.instances, reference.blases);
  expect(a.buffer).toEqual(b.buffer); expect(a.instancesBuffer).toEqual(b.instancesBuffer);
  const merged = mergeMeshesToGeometry([mesh]), old = mergeMeshesToGeometry(singles);
  expect(merged.geometry.position.array).toEqual(old.geometry.position.array);
  mesh.transforms[28] = 14; mesh.markTransformsUpdated(1,1);
  const next = updateMeshInstanceTransforms(packed.instanceBindings);
  refitTLAS(a, next, packed.blases);
  const rebuilt = buildTLAS(next, packed.blases);
  // Refit preserves topology; compare source record matrices to fresh preparation.
  expect(readMeshInstance(next, 1).transform[12]).toBe(14 + mesh.transform[12]);
  expect(new Float32Array(a.instancesBuffer!).every(Number.isFinite)).toBe(true);
  expect(new Float32Array(rebuilt.instancesBuffer!).every(Number.isFinite)).toBe(true);
});
it('keeps geometry materialIndex selection shared across instances', () => {
  const geometry = new Geometry({position: new Attribute(new Float32Array([0,0,0,1,0,0,0,1,0,2,0,0,3,0,0,2,1,0]),3),
    materialIndex: new Attribute(new Int32Array([0,0,0,1,1,1]),1)});
  const mesh = new InstancedMesh(geometry, [material(), material()], {count: 4});
  const prepared = updateMeshInstances([mesh]);
  expect(prepared.geometries).toHaveLength(1); expect(prepared.instances.length).toBe(4);
  expect([...prepared.geometry.materialIndex!.array.slice(0,24)]).toEqual([255,0,0,0,255,0,0,0,255,0,0,0,511,0,0,0,511,0,0,0,511,0,0,0]);
});
it('reuses BLAS/vertices when a batch shrinks, disappears and returns', () => {
  const mesh = batch(), resident = updateMeshInstances([mesh]), cache = new MeshMembershipCache(); cache.capture(resident);
  mesh.count = 1; const small = cache.update(resident, [mesh])!;
  expect(small.instances.length).toBe(1); expect(small.blases).toBe(resident.blases); expect(small.geometry).toBe(resident.geometry);
  const empty = cache.update(small, [])!; expect(empty.instances.length).toBe(0);
  mesh.count = 3; const restored = cache.update(empty, [mesh])!; expect(restored.instances.length).toBe(3);
  expect(restored.blases).toBe(resident.blases);
});
it('excludes invalid world matrices and notices source membership changes even at equal length', () => {
  const mesh = batch(); mesh.transforms[12] = NaN;
  const prepared = updateMeshInstances([mesh]); expect(prepared.instances.length).toBe(2);
  mesh.transforms[12] = 0; mesh.transforms[28] = NaN; mesh.markTransformsUpdated();
  const next = updateMeshInstanceTransforms(prepared.instanceBindings);
  expect(next.length).toBe(2); expect(sameInstanceMembership(next, prepared.instances)).toBe(false);
});
it('samples all emissive instances and invalidates the batch cache on matrix/count edits', () => {
  const mesh = new InstancedMesh(createPlaneGeometry(), new OpenPBRMaterial({emissionLuminance: 2}), {count: 2});
  mesh.transforms[28] = 3;
  const binding = {mesh, geometry: mesh.geometry, materialIndices: [0]}, cache = new EmissiveTriangleCache();
  const actual = collectEmissiveTriangles([binding], mesh.materials);
  const reference = collectEmissiveTriangles(expanded(mesh).map(single => ({...binding, mesh: single})), mesh.materials);
  expect(actual).toEqual(reference); expect(actual).toHaveLength(4);
  const first = cache.collect([binding], mesh.materials)[0];
  mesh.transforms[12] = 8; mesh.markTransformsUpdated(0,1);
  expect(cache.collect([binding], mesh.materials)[0]).not.toBe(first);
  mesh.count = 1; expect(cache.collect([binding], mesh.materials)).toHaveLength(2);
});

it('keeps explicit single-material vertex indices distinct across batches with different materials', () => {
  const geometry = createPlaneGeometry(); geometry.materialIndex = new Attribute(new Int32Array(geometry.vertexCount),1);
  const first = new InstancedMesh(geometry,material(),{count:2});
  const second = new InstancedMesh(geometry,material(),{count:2});
  const prepared = updateMeshInstances([first,second]);
  expect(prepared.geometries).toHaveLength(2); expect(prepared.instances.length).toBe(4);
  const [a,b] = prepared.geometries;
  expect(prepared.geometryRegions.get(a)!.materialIndices).toEqual([0]);
  expect(prepared.geometryRegions.get(b)!.materialIndices).toEqual([1]);
  const same = new InstancedMesh(geometry,first.materials,{count:2});
  expect(updateMeshInstances([first,same]).geometries).toHaveLength(1);
});

it('isolates separately notified batches even when they share an external transforms array', () => {
  const {engine,pipeline} = renderFixture(), a = batch();
  const b = new InstancedMesh(a.geometry,a.materials,{count:a.count,transforms:a.transforms});
  engine.scene = {meshes:[a,b],lights:[]}; engine.update();
  const committed = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0] as InstancedMesh[];
  expect(committed[0].transforms).not.toBe(committed[1].transforms);
  a.transforms[12] = 7; a.markTransformsUpdated(0,1); engine.update();
  expect(committed[0].transforms[12]).toBe(7); expect(committed[1].transforms[12]).toBe(0);
  b.markTransformsUpdated(0,1); engine.update(); expect(committed[1].transforms[12]).toBe(7);
  engine.dispose();
});
