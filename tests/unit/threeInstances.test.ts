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

it('expands world transforms, shares geometry and deduplicates colors', () => {
  const { source, mesh, sync } = fixture();
  expect(sync.scene.meshes).toHaveLength(4);
  const [a, b, c] = sync.scene.meshes;
  expect(a.geometry).toBe(b.geometry);
  expect(a.materials[0]).toBe(c.materials[0]);
  expect(a.materials[0]).not.toBe(b.materials[0]);
  expect(b.materials[0].baseColor).toEqual([.5, .25, .75]);
  const local = new THREE.Matrix4(), world = new THREE.Matrix4();
  mesh.getMatrixAt(3, local); world.multiplyMatrices(mesh.matrixWorld, local);
  expect([...sync.scene.meshes[3].transform]).toEqual(world.elements);
  expect(fromTHREEScene(source).meshes).toHaveLength(4);
  sync.update();
});

it('retains the prefix when count changes and reports matrix edits only as transforms', () => {
  const { mesh, sync } = fixture();
  const initial = sync.scene.meshes.slice(), matrix = initial[1].transform;
  ensureMeshGeometryAttributes(sync.scene.meshes); sync.update();
  const detector = new SceneChangeDetector(); detector.detect(sync.scene); detector.commit();
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(8, 0, 0)); mesh.instanceMatrix.needsUpdate = true;
  sync.update();
  const changes = detector.detect(sync.scene);
  expect(changes.meshes).toBe('incremental'); expect(changes.transforms).toEqual([initial[1]]); expect(changes.geometries).toEqual([]);
  expect(initial[1].transform).toBe(matrix);
  mesh.count = 2; sync.update();
  expect(sync.scene.meshes).toEqual(initial.slice(0, 2));
  mesh.count = 4; sync.update();
  expect(sync.scene.meshes[0]).toBe(initial[0]); expect(sync.scene.meshes[1]).toBe(initial[1]);
  expect(sync.scene.meshes[2].geometry).toBe(initial[0].geometry);
});

it.each([false, true])('propagates source edits to color variants, including unlit=%s', basic => {
  const { mesh, sync, material } = fixture(basic);
  const first = sync.scene.meshes[0].materials[0], second = sync.scene.meshes[1].materials[0];
  const mark = vi.spyOn(first, 'markUpdated');
  material.color.setRGB(.2, .4, .8); material.opacity = .6;
  sync.update(); expect(mark).toHaveBeenCalledOnce();
  expect(first.baseColor).toEqual([.2, .1, .8 * .75]); expect(second.baseColor).toEqual([.1, .1, .8 * .75]);
  expect(first.opacity).toBe(.6); if (basic) expect(first.emissionColor).toEqual(first.baseColor);
  mesh.setColorAt(0, new THREE.Color(.5, .25, .75)); mesh.instanceColor!.needsUpdate = true;
  sync.update(); expect(sync.scene.meshes[0].materials[0]).toBe(second);
  material.color.setRGB(.4, .4, .4); sync.update();
  // The currently absent original color also remains synchronized.
  expect(first.baseColor).toEqual([.4, .1, .4 * .75]);
  mesh.setColorAt(0, new THREE.Color(1, .25, .75)); mesh.instanceColor!.needsUpdate = true;
  sync.update(); expect(sync.scene.meshes[0].materials[0]).toBe(first);
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
  expect(next.materials).toHaveLength(3);
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
  return (sync as unknown as { _store: { colorVariants: Map<THREE.Material, Map<string, unknown>> } })._store.colorVariants;
}
it('keeps only currently distinct instance colors after 100 consecutive color changes', () => {
  const {mesh, sync, material} = fixture();
  let prepared = updateMeshInstances(sync.scene.meshes);
  const membership = new MeshMembershipCache(); membership.capture(prepared);
  for (let frame = 0; frame < 100; frame++) {
    for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i,new THREE.Color((frame+1)/101,i%3/4,.5));
    mesh.instanceColor!.needsUpdate = true; sync.update();
    expect(variantCache(sync).get(material)!.size).toBe(3);
    expect(new Set(sync.scene.meshes.map(mesh=>mesh.materials[0])).size).toBe(3);
    const next = membership.update(prepared, sync.scene.meshes)!;
    expect(next.blases).toBe(prepared.blases); expect(next.geometry).toBe(prepared.geometry);
    expect(next.materials).toHaveLength(3);
    for (const binding of next.instanceBindings) expect(next.materials[binding.materialIndices[0]]).toBe(binding.mesh.materials[0]);
    prepared = next;
  }
  mesh.count=0;sync.update();expect(variantCache(sync).size).toBe(0);
  mesh.count=4;sync.update();expect(variantCache(sync).get(material)!.size).toBe(3);
});
it('prunes across shared source materials and removed or invisible instances', () => {
  const {mesh, sync, material, source} = fixture();
  const second = new THREE.InstancedMesh(mesh.geometry,material,1);
  second.setColorAt(0,new THREE.Color(.25,.5,.75));source.add(second);sync.update();
  const retained = sync.scene.meshes.at(-1)!.materials[0];
  expect(variantCache(sync).get(material)!.size).toBe(3);
  mesh.visible=false;sync.update();
  expect(variantCache(sync).get(material)!.size).toBe(1);
  expect(sync.scene.meshes[0].materials[0]).toBe(retained);
  source.remove(second);sync.update();expect(variantCache(sync).size).toBe(0);
  mesh.visible=true;sync.update();expect(variantCache(sync).get(material)!.size).toBe(2);
});
it('recreates an unused color with the current source material values', () => {
  const {mesh, sync, material} = fixture(true), old = sync.scene.meshes[0].materials[0];
  mesh.count=0;sync.update();material.color.setRGB(.2,.4,.8);sync.update();
  mesh.count=4;sync.update();const current=sync.scene.meshes[0].materials[0];
  expect(current).not.toBe(old);expect(current.baseColor).toEqual([.2,.1,.8*.75]);
  expect(current.emissionColor).toEqual(current.baseColor);
});

it('combines instance colors with automatic projection in the variant cache', () => {
  const source = new THREE.Scene(), map = new THREE.Texture({ width: 2, height: 2 });
  const material = new THREE.MeshBasicMaterial({ map });
  const uv = new THREE.BoxGeometry(), uvless = new THREE.BoxGeometry(); uvless.deleteAttribute('uv');
  const a = new THREE.InstancedMesh(uv, material, 2), b = new THREE.InstancedMesh(uvless, material, 2);
  for (const mesh of [a, b]) for (let i = 0; i < 2; i++) mesh.setColorAt(i, new THREE.Color(.5, .25, .75));
  source.add(a, b, new THREE.Mesh(uv, material));
  const sync = initializedSync(source);
  const [a0, a1, b0, b1, plain] = sync.scene.meshes;
  expect(a0.materials[0]).toBe(a1.materials[0]); expect(b0.materials[0]).toBe(b1.materials[0]);
  expect(a0.materials[0]).not.toBe(b0.materials[0]); expect(a0.materials[0]).not.toBe(plain.materials[0]);
  expect(a0.materials[0].uvProjection).toBe('none'); expect(b0.materials[0].uvProjection).toBe('triplanar');
  expect(variantCache(sync).get(material)!.size).toBe(2);
  material.color.setRGB(.2, .4, .8); sync.update();
  for (const mesh of [a0, b0]) {
    expect(mesh.materials[0].baseColor).toEqual([.1, .1, .8 * .75]);
    expect(mesh.materials[0].emissionColor).toEqual(mesh.materials[0].baseColor);
  }
  b.geometry = uv; sync.update();
  expect(b0.materials[0]).toBe(a0.materials[0]); expect(variantCache(sync).get(material)!.size).toBe(1);
  a.count = b.count = 0; sync.update(); expect(variantCache(sync).size).toBe(0);
});

function initializedSync(scene: THREE.Scene, options: import('../../src/util/fromTHREE').FromTHREESceneOptions = {}) {
  const sync = new THREESync(new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}), {scene, ...options});
  sync.update(); return sync as THREESync & {scene: NonNullable<THREESync['scene']>};
}
