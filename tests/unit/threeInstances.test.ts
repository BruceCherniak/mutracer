import InstancedMesh from '../../src/scene/InstancedMesh';
import { meshInstanceTransform } from '../../src/renderer/meshInstances';
import Engine from '../../src/Engine';
import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { fromTHREEScene, THREESync } from '../../src/util/fromTHREE';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import { ensureMeshGeometryAttributes, updateMeshInstances } from '../../src/renderer/prepareMeshBVH';
import { MeshMembershipCache } from '../../src/renderer/meshMembership';

function fixture(basic = false) {
  const source = new THREE.Scene();
  const material = basic ? new THREE.MeshBasicMaterial({ color: 0xffffff }) : new THREE.MeshStandardMaterial({ color: 0xffffff });
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 4);
  for (let i = 0; i < 4; i++) {
    mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i, 0, 0));
    mesh.setColorAt(i, new THREE.Color(i % 2 ? .5 : 1, .25, .75));
  }
  mesh.position.set(2, 3, 4);
  source.add(mesh);
  const sync = initializedSync(source);
  return { source, material, mesh, sync };
}

it('keeps colors in one batch and copies matrices in source index order', () => {
  const {source, mesh, sync} = fixture();
  expect(sync.scene.meshes).toHaveLength(1);
  const batch = sync.scene.meshes[0] as InstancedMesh;
  expect(batch.count).toBe(4); expect(batch.colors).toEqual(mesh.instanceColor!.array);
  expect(batch.materials[0].baseColor).toEqual([1,1,1]);
  const local = new THREE.Matrix4(), world = new THREE.Matrix4();
  mesh.getMatrixAt(3, local); world.multiplyMatrices(mesh.matrixWorld, local);
  expect([...meshInstanceTransform(batch, 3, Array(16).fill(0))]).toEqual(world.elements);
  expect(fromTHREEScene(source).meshes).toHaveLength(1);
});

it('retains the prefix when count changes and reports matrices separately from colors', () => {
  const {mesh, sync} = fixture(), batch = sync.scene.meshes[0] as InstancedMesh;
  const matrices = batch.transforms, colors = batch.colors;
  ensureMeshGeometryAttributes(sync.scene.meshes); sync.update();
  const detector = new SceneChangeDetector(); detector.detect(sync.scene); detector.commit();
  mesh.setMatrixAt(1,new THREE.Matrix4().makeTranslation(8,0,0)); mesh.instanceMatrix.needsUpdate = true; sync.update();
  expect(detector.detect(sync.scene)).toMatchObject({meshes:'incremental',transforms:[batch],colors:[],geometries:[]}); detector.commit();
  const version = batch.version;
  mesh.setColorAt(2,new THREE.Color(.2,.3,.4)); mesh.instanceColor!.needsUpdate = true; sync.update();
  expect(batch.version).toBe(version + 1);
  expect(detector.detect(sync.scene)).toMatchObject({meshes:'incremental',transforms:[],colors:[batch],materials:[],geometries:[]}); detector.commit();
  sync.update(); expect(batch.version).toBe(version + 1); expect(detector.detect(sync.scene).meshes).toBe('none');
  mesh.count = 2; sync.update(); expect(batch.count).toBe(2);
  mesh.count = 4; sync.update(); expect(sync.scene.meshes[0]).toBe(batch); expect(batch.count).toBe(4);
  expect(batch.transforms).toBe(matrices); expect(batch.colors).toBe(colors); expect(batch.transforms[28]).toBe(8);
  detector.detect(sync.scene); detector.commit();
  mesh.instanceColor = null; sync.update(); expect(batch.colors).toBeUndefined();
  expect(detector.detect(sync.scene).transforms).toEqual([]);
});

it.each([false,true])('retains a shared material through source and color edits, unlit=%s', basic => {
  const {mesh, sync, material} = fixture(basic), batch = sync.scene.meshes[0] as InstancedMesh, converted = batch.materials[0];
  material.color.setRGB(.2,.4,.8); material.opacity = .6; sync.update();
  expect(converted.baseColor).toEqual([.2,.4,.8]); expect(converted.opacity).toBe(.6);
  if (basic) expect(converted.emissionColor).toEqual(converted.baseColor);
  mesh.setColorAt(0,new THREE.Color(.5,.25,.75)); mesh.instanceColor!.needsUpdate = true; sync.update();
  expect(batch.materials[0]).toBe(converted); expect(batch.colors).toEqual(mesh.instanceColor!.array);
  expect(converted.baseColor).toEqual([.2,.4,.8]);
});

it('reuses resident BLAS and vertices across removals, new instances and new colors', () => {
  const { mesh, sync } = fixture();
  const resident = updateMeshInstances(sync.scene.meshes), cache = new MeshMembershipCache(); cache.capture(resident);
  mesh.count = 0; sync.update(); const empty = cache.update(resident, sync.scene.meshes)!;
  expect(empty.instances).toHaveLength(0); expect(empty.materials).toHaveLength(0);
  mesh.count = 4; mesh.setColorAt(3, new THREE.Color(.3, .2, .1)); mesh.instanceColor!.needsUpdate = true; sync.update();
  const next = cache.update(empty, sync.scene.meshes)!;
  expect(next.instances).toHaveLength(4); expect(next.blases).toBe(resident.blases);
  expect(next.geometry).toBe(resident.geometry); expect(next.geometries).toBe(resident.geometries);
  expect(next.materials).toHaveLength(1);
  sync.scene.meshes[0].geometry.position.array[0] += .1; sync.scene.meshes[0].geometry.markUpdated();
  expect(cache.update(next, sync.scene.meshes)).toBeUndefined();
});

it('warns once and falls back to an ordinary mesh for unsupported instanced morph data', () => {
  const { mesh, sync } = fixture();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mesh.morphTexture = new THREE.DataTexture(); sync.update(); sync.update();
    expect(warning).toHaveBeenCalledOnce(); expect(sync.scene.meshes).toHaveLength(1);
  } finally { warning.mockRestore(); }
});

function variantCache(sync: THREESync & {scene: NonNullable<THREESync['scene']>}) {
  return (sync as unknown as { _store: { projectionVariants: Map<THREE.Material, Map<string, unknown>> } })._store.projectionVariants;
}
it('keeps one material through 100 consecutive color changes', () => {
  const {mesh, sync} = fixture();
  let prepared = updateMeshInstances(sync.scene.meshes);
  const membership = new MeshMembershipCache(); membership.capture(prepared);
  for (let frame = 0; frame < 100; frame++) {
    for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i,new THREE.Color((frame+1)/101,i%3/4,.5));
    mesh.instanceColor!.needsUpdate = true; sync.update();
    expect(variantCache(sync).size).toBe(0);
    expect(new Set(sync.scene.meshes.map(mesh=>mesh.materials[0])).size).toBe(1);
    const next = membership.update(prepared, sync.scene.meshes)!;
    expect(next.blases).toBe(prepared.blases); expect(next.geometry).toBe(prepared.geometry);
    expect(next.materials).toHaveLength(1);
    for (const binding of next.instanceBindings) expect(next.materials[binding.materialIndices[0]]).toBe(binding.mesh.materials[0]);
    prepared = next;
  }
  mesh.count=0;sync.update();expect(variantCache(sync).size).toBe(0);
  mesh.count=4;sync.update();expect(variantCache(sync).size).toBe(0);
});
it('shares materials across source objects with different colors', () => {
  const {mesh, sync, material, source} = fixture();
  const second = new THREE.InstancedMesh(mesh.geometry,material,1);
  second.setColorAt(0,new THREE.Color(.25,.5,.75));source.add(second);sync.update();
  const retained = sync.scene.meshes.at(-1)!.materials[0];
  expect(variantCache(sync).size).toBe(0);
  mesh.visible=false;sync.update();
  expect(variantCache(sync).size).toBe(0);
  expect(sync.scene.meshes[0].materials[0]).toBe(retained);
  source.remove(second);sync.update();expect(variantCache(sync).size).toBe(0);
  mesh.visible=true;sync.update();expect(variantCache(sync).size).toBe(0);
});
it('restores a batch with the current source material values', () => {
  const {mesh, sync, material} = fixture(true), old = sync.scene.meshes[0].materials[0];
  mesh.count=0;sync.update();material.color.setRGB(.2,.4,.8);sync.update();
  mesh.count=4;sync.update();const current=sync.scene.meshes[0].materials[0];
  expect(current).toBe(old);expect(current.baseColor).toEqual([.2,.4,.8]);
  expect(current.emissionColor).toEqual(current.baseColor);
});

it('keeps projection variants independent of instance colors', () => {
  const source = new THREE.Scene(), map = new THREE.Texture({ width: 2, height: 2 });
  const material = new THREE.MeshBasicMaterial({ map });
  const uv = new THREE.BoxGeometry(), uvless = new THREE.BoxGeometry(); uvless.deleteAttribute('uv');
  const a = new THREE.InstancedMesh(uv, material, 2), b = new THREE.InstancedMesh(uvless, material, 2);
  for (const mesh of [a, b]) for (let i = 0; i < 2; i++) mesh.setColorAt(i, new THREE.Color(.5, .25, .75));
  source.add(a, b, new THREE.Mesh(uv, material));
  const sync = initializedSync(source);
  const [a0, b0, plain] = sync.scene.meshes;
  expect((a0 as InstancedMesh).count).toBe(2); expect((b0 as InstancedMesh).count).toBe(2);
  expect(a0.materials[0]).not.toBe(b0.materials[0]); expect(a0.materials[0]).toBe(plain.materials[0]);
  expect(a0.materials[0].uvProjection).toBe('none'); expect(b0.materials[0].uvProjection).toBe('triplanar');
  expect(variantCache(sync).get(material)!.size).toBe(1);
  material.color.setRGB(.2, .4, .8); sync.update();
  for (const mesh of [a0, b0]) {
    expect(mesh.materials[0].baseColor).toEqual([.2, .4, .8]);
    expect(mesh.materials[0].emissionColor).toEqual(mesh.materials[0].baseColor);
  }
  b.geometry = uv; sync.update();
  expect(sync.scene.meshes[1].materials[0]).toBe(a0.materials[0]); expect(variantCache(sync).size).toBe(0);
  a.count = b.count = 0; sync.update(); expect(variantCache(sync).size).toBe(0);
});

function initializedSync(scene: THREE.Scene, options: import('../../src/util/fromTHREE').FromTHREESceneOptions = {}) {
  const sync = new THREESync(new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}), {scene, ...options});
  sync.update(); return sync as THREESync & {scene: NonNullable<THREESync['scene']>};
}

it('retains an uncolored batch prefix and drops retired material identities', () => {
  const source = new THREE.Scene(), mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 4);
  source.add(mesh); const sync = initializedSync(source);
  const first = sync.scene.meshes[0] as InstancedMesh, storage = first.transforms;
  mesh.count = 2; sync.update(); expect(sync.scene.meshes[0]).toBe(first); expect(first.transforms).toBe(storage);
  mesh.count = 4; sync.update(); expect(sync.scene.meshes[0]).toBe(first); expect(first.count).toBe(4);
  for (let i = 0; i < 10; i++) {mesh.material = new THREE.MeshStandardMaterial();sync.update();}
  const groups = (sync as unknown as {_store: {instanceMeshes: WeakMap<THREE.Mesh, Map<number, InstancedMesh>>}})._store.instanceMeshes;
  expect(groups.get(mesh)!.get(0)).toBe(first);
  mesh.count = 0; sync.update(); expect(groups.get(mesh)!.get(0)!.count).toBe(0);
});

it('calls conversion once per group and keeps group colors in source order', () => {
  const source = new THREE.Scene(), geometry = new THREE.BoxGeometry();
  const mesh = new THREE.InstancedMesh(geometry, [new THREE.MeshBasicMaterial(),new THREE.MeshBasicMaterial()], 3);
  for (const group of geometry.groups) group.materialIndex = group.materialIndex! % 2;
  for (let i=0;i<3;i++) mesh.setColorAt(i,new THREE.Color(i/3,.3,.6)); source.add(mesh);
  const callback = vi.fn(); const sync = initializedSync(source,{onMeshConverted:callback});
  expect(callback).toHaveBeenCalledTimes(geometry.groups.length);
  for (const batch of sync.scene.meshes as InstancedMesh[]) { expect(batch.count).toBe(3); expect(batch.colors).toEqual(mesh.instanceColor!.array); }
  callback.mockClear(); sync.update(); expect(callback).toHaveBeenCalledTimes(geometry.groups.length);
});
