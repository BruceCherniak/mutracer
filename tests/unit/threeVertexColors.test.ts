import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import Engine from '../../src/Engine';
import InstancedMesh from '../../src/scene/InstancedMesh';
import { updateMeshInstances } from '../../src/renderer/prepareMeshBVH';
import { updatePreparedGeometries } from '../../src/renderer/geometryUpdates';
import { fromTHREEScene, THREESync } from '../../src/util/fromTHREE';

const rgb = [1, 0.5, 0.25, 0.125, 1, 0, 0, 0.25, 2];

function triangle() {
  return new THREE.BufferGeometry().setAttribute('position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
}

function fixture(attribute = new THREE.Float32BufferAttribute(rgb, 3)) {
  const geometry = triangle().setAttribute('color', attribute);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  const source = new THREE.Scene();
  source.add(new THREE.Mesh(geometry, material));
  return { source, geometry, material };
}

function syncScene(source: THREE.Scene) {
  const sync = new THREESync(new Engine({ canvas: { width: 1, height: 1 } as HTMLCanvasElement }), { scene: source });
  sync.update();
  return sync as THREESync & { scene: NonNullable<THREESync['scene']> };
}

describe('Three.js vertex colors', () => {
  it.each([false, true])('copies linear RGB into independent float storage (indexed=%s)', indexed => {
    const { source, geometry } = fixture();
    if (indexed) geometry.setIndex([2, 0, 1]);
    const converted = fromTHREEScene(source).meshes[0].geometry;
    expect(converted.color?.itemSize).toBe(3);
    expect(converted.color?.array).toEqual(new Float32Array(rgb));
    expect(converted.color?.array).not.toBe(geometry.attributes.color.array);
    expect([...converted.indices.array]).toEqual(indexed ? [2, 0, 1] : [0, 1, 2]);
  });

  it.each([false, true])('decodes normalized integer RGBA as RGB (interleaved=%s)', interleaved => {
    const values = [255, 128, 0, 64, 0, 255, 64, 128, 32, 0, 255, 255];
    const color = interleaved
      ? new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(
        new Uint8Array([99, ...values.slice(0, 4), 99, ...values.slice(4, 8), 99, ...values.slice(8)]), 5), 4, 1, true)
      : new THREE.Uint8BufferAttribute(values, 4, true);
    const { source, geometry } = fixture();
    geometry.setAttribute('color', color);
    const converted = fromTHREEScene(source).meshes[0].geometry.color;
    expect(converted?.itemSize).toBe(3);
    expect(converted?.array).toEqual(new Float32Array([1, 128 / 255, 0, 0, 1, 64 / 255, 32 / 255, 0, 1]));
  });

  it('reads float RGBA from interleaved storage without copying alpha or padding', () => {
    const { source, geometry } = fixture();
    const data = new Float32Array([99, 1, .5, .25, .1, 99, .125, 1, 0, .2, 99, 0, .25, 2, .3]);
    geometry.setAttribute('color', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(data, 5), 4, 1));
    expect(fromTHREEScene(source).meshes[0].geometry.color?.array).toEqual(new Float32Array(rgb));
  });

  it('respects per-material switches with shared geometry and refreshes switches', () => {
    const { source, geometry, material } = fixture();
    const disabled = new THREE.MeshBasicMaterial();
    source.add(new THREE.Mesh(geometry, disabled), new THREE.Mesh(geometry, material));
    const sync = syncScene(source);
    const [a, b, c] = sync.scene.meshes;
    expect(a.geometry.color?.array).toEqual(new Float32Array(rgb));
    expect(b.geometry.color).toBeUndefined();
    expect(c.geometry).toBe(a.geometry);
    expect(b.geometry).not.toBe(a.geometry);
    const packed = updateMeshInstances(sync.scene.meshes);
    const region = packed.geometryRegions.get(b.geometry)!;
    expect(packed.geometry.color?.array.slice(region.vertexOffset * 3, (region.vertexOffset + 3) * 3))
      .toEqual(new Float32Array(9).fill(1));
    b.geometry.position.array[0] += .1; b.geometry.markVerticesUpdated();
    updatePreparedGeometries(packed, new Set([b.geometry]));
    expect(packed.geometry.color?.array.slice(region.vertexOffset * 3, (region.vertexOffset + 3) * 3))
      .toEqual(new Float32Array(9).fill(1));
    disabled.vertexColors = true;
    sync.update();
    expect(b.geometry).toBe(a.geometry);
    material.vertexColors = false;
    sync.update();
    expect(a.geometry.color).toBeUndefined();
    expect(c.geometry).toBe(a.geometry);
    expect(b.geometry.color?.array).toEqual(new Float32Array(rgb));
  });

  it.each([false, true])('updates, replaces, removes and restores colors (interleaved=%s)', interleaved => {
    const { source, geometry } = fixture();
    if (interleaved) geometry.setAttribute('color', new THREE.InterleavedBufferAttribute(
      new THREE.InterleavedBuffer(new Float32Array(rgb), 3), 3, 0));
    const sync = syncScene(source);
    const mesh = sync.scene.meshes[0], initial = mesh.geometry;
    sync.update(); expect(mesh.geometry).toBe(initial);
    const color = geometry.getAttribute('color');
    color.setX(0, .75);
    color.needsUpdate = true;
    sync.update();
    expect(mesh.geometry).not.toBe(initial);
    expect(mesh.geometry.color?.array[0]).toBe(.75);
    const edited = mesh.geometry;
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(rgb, 3));
    sync.update();
    expect(mesh.geometry).not.toBe(edited);
    expect(mesh.geometry.color?.array).toEqual(new Float32Array(rgb));
    geometry.deleteAttribute('color'); sync.update();
    expect(mesh.geometry.color).toBeUndefined();
    geometry.setAttribute('color', color); sync.update();
    expect(mesh.geometry.color?.array[0]).toBe(.75);
    const restored = mesh.geometry;
    sync.update(); expect(mesh.geometry).toBe(restored);
  });

  it('keeps per-group switches and vertex colors separate from instance colors', () => {
    const { source, geometry, material } = fixture();
    geometry.setIndex([0, 1, 2, 2, 1, 0]);
    geometry.addGroup(0, 3, 0); geometry.addGroup(3, 3, 1);
    source.clear();
    const mesh = new THREE.InstancedMesh(geometry, [material, new THREE.MeshStandardMaterial()], 1);
    mesh.setColorAt(0, new THREE.Color(.5, .25, 1)); source.add(mesh);
    const [enabled, disabled] = fromTHREEScene(source).meshes as InstancedMesh[];
    expect(enabled.geometry.color?.array).toEqual(new Float32Array(rgb));
    expect(disabled.geometry.color).toBeUndefined();
    expect(enabled.colors).toEqual(new Float32Array([.5, .25, 1]));
    expect(disabled.colors).toEqual(enabled.colors);
  });

  it('retains colors through morph poses and refreshes color edits at an unchanged pose', () => {
    const { source, geometry, material } = fixture();
    const target = geometry.attributes.position.clone();
    for (let i = 0; i < target.count; i++) target.setX(i, target.getX(i) + 1);
    geometry.morphAttributes.position = [target];
    const mesh = source.children[0] as THREE.Mesh;
    mesh.updateMorphTargets(); mesh.morphTargetInfluences![0] = .5;
    const sync = syncScene(source), converted = sync.scene.meshes[0];
    const initial = converted.geometry;
    expect(initial.color?.array).toEqual(new Float32Array(rgb));
    mesh.morphTargetInfluences![0] = .75; sync.update();
    expect(converted.geometry).toBe(initial);
    material.vertexColors = false;
    mesh.morphTargetInfluences![0] = .25; sync.update();
    material.vertexColors = true; sync.update();
    expect(converted.geometry.position.array[0]).toBe(.25);
    const color = geometry.getAttribute('color'); color.setX(0, .75); color.needsUpdate = true;
    sync.update();
    expect(converted.geometry.color?.array[0]).toBe(.75);
    expect(converted.geometry.dynamic).toBe(true);
  });
});
