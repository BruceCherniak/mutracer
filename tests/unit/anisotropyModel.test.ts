import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import Material, { getMaterialHashKey } from '../../src/scene/OpenPBRMaterial';
import MaterialTable from '../../src/renderer/MaterialTable';
import Texture from '../../src/scene/Texture';
import { MaterialChangeTracker } from '../../src/renderer/materialChanges';
import { fromTHREEScene, THREESync } from '../../src/util/fromTHREE';
import Engine from '../../src/Engine';
import Mesh from '../../src/scene/Mesh';
import { createPlaneGeometry } from '../../src/util/commonGeometry';
import { ensureMeshGeometryAttributes } from '../../src/renderer/prepareMeshBVH';
const texture = () => new Texture({ width: 1, height: 1, data: new Uint8Array([255, 128, 200, 255]) });
function setup(metadata?: Record<string, unknown>) {
  const m = new THREE.MeshPhysicalMaterial({ roughness: .3, anisotropy: .7, anisotropyRotation: .4 });
  m.anisotropyMap = new THREE.Texture({ width: 1, height: 1 });
  m.anisotropyMap.channel = 1;
  m.anisotropyMap.repeat.set(2, 3);
  m.userData.mutracerOpenPBR = metadata;
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), m));
  return { source: m, scene };
}
function convert(metadata?: Record<string, unknown>) {
  return fromTHREEScene(setup(metadata).scene).meshes[0].materials[0];
}
describe('anisotropy source convention', () => {
  it('keeps native defaults and packs source parameters without preconverting texture factors', () => {
    const map = texture();
    const native = new Material(), source = new Material({ specularAnisotropyModel: 'gltf', specularRoughness: .3, specularRoughnessAnisotropy: .7, roughnessMap: map, anisotropyMap: map });
    const table = new MaterialTable([native, source], []), a = table.getBufferArray();
    expect(a.length).toBe(208);
    expect(a[101]).toBe(0);
    expect(a[205]).toBe(1);
    expect(a[108]).toBeCloseTo(.3);
    expect(a[113]).toBeCloseTo(.7);
    expect(a[200]).toBe(0);
    source.specularAnisotropyRotation = .9;
    table.repackParams([native, source]);
    expect(table.getBufferArray()[200]).toBe(0);
    expect(source.specularRoughness).toBe(.3);
    expect(source.specularAnisotropy).toBe(.7);
  });
  it('clamps and defaults source scalars while retaining legacy native packing', () => {
    for (const [r, a, expectedR, expectedA] of [[-1, 2, 0, 1], [2, -1, 1, 0], [NaN, Infinity, .3, 0]] as const) {
      const m = new Material({ specularAnisotropyModel: 'gltf', specularRoughness: r, specularRoughnessAnisotropy: a });
      const p = new MaterialTable([m], []).getBufferArray();
      expect(p[4]).toBeCloseTo(expectedR);
      expect(p[9]).toBeCloseTo(expectedA);
    }
    const p = new MaterialTable([new Material({ specularRoughness: 2, specularAnisotropy: -1 })], []).getBufferArray();
    expect(p[4]).toBe(2);
    expect(p[9]).toBe(-1);
  });
  it('rejects invalid model names in construction, runtime packing and metadata', () => {
    expect(() => new Material({ specularAnisotropyModel: 'unknown' as never })).toThrow(/specularAnisotropyModel/);
    const m = new Material();
    m.specularAnisotropyModel = undefined as never;
    expect(() => new MaterialTable([m], [])).toThrow(/specularAnisotropyModel/);
    expect(() => convert({ specularAnisotropyModel: 'bad' })).toThrow(/specularAnisotropyModel/);
  });
  it('classifies the source model as a parameter and includes it in the hash', () => {
    const m = new Material(), t = new MaterialChangeTracker();
    t.capture([m]);
    const h = getMaterialHashKey(m);
    m.specularAnisotropyModel = 'gltf';
    m.markUpdated();
    expect(t.classify([m])).toEqual({ level: 'params', emission: false, emissiveMap: false });
    expect(getMaterialHashKey(m)).not.toBe(h);
  });
  it('diagnoses missing source tangents once and leaves zero source strength quiet', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const zero = new Mesh(createPlaneGeometry(), new Material({specularAnisotropyModel: 'gltf'}));
      ensureMeshGeometryAttributes([zero]);
      expect(warning).not.toHaveBeenCalled();
      const mesh = new Mesh(createPlaneGeometry(), new Material({specularAnisotropyModel: 'gltf', specularAnisotropy: .5}));
      ensureMeshGeometryAttributes([mesh]);
      expect(mesh.geometry.tangent).toBeDefined();
      mesh.geometry.tangent = undefined;
      ensureMeshGeometryAttributes([mesh]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
  it('imports raw Three source strength, rotation and shared texture transforms', () => {
    const m = convert();
    expect(m.specularAnisotropyModel).toBe('gltf');
    expect(m.specularRoughness).toBe(.3);
    expect(m.specularAnisotropy).toBe(.7);
    expect(m.specularAnisotropyRotation).toBe(.4);
    expect(m.anisotropyMap?.uvChannel).toBe(1);
    expect(m.anisotropyMap?.uvScale).toEqual([2, 3]);
  });
  it.each(['specularAnisotropy', 'specularRoughnessAnisotropy'])('resolves %s metadata as native and clears automatic directions', key => {
    const m = convert({ [key]: .5 });
    expect(m.specularAnisotropyModel).toBe('openpbr');
    expect(m.specularAnisotropy).toBe(.5);
    expect(m.specularAnisotropyRotation).toBe(0);
    expect(m.anisotropyMap).toBeUndefined();
  });
  it('preserves source semantics for unrelated metadata or an explicit source model', () => {
    const a = convert({ baseColor: [.1, .2, .3] });
    expect(a.specularAnisotropyModel).toBe('gltf');
    expect(a.anisotropyMap).toBeDefined();
    expect(a.specularAnisotropyRotation).toBe(.4);
    const b = convert({ specularAnisotropy: .5, specularAnisotropyModel: 'gltf' });
    expect(b.specularAnisotropyModel).toBe('gltf');
    expect(b.anisotropyMap).toBeDefined();
    expect(b.specularAnisotropyRotation).toBe(.4);
  });
  it('accepts explicit native direction overrides, texture clearing and nonphysical materials', () => {
    const map = texture(), m = convert({ specularAnisotropy: .5, anisotropyMap: map, specularAnisotropyRotation: .9 });
    expect(m.anisotropyMap).toBe(map);
    expect(m.specularAnisotropyRotation).toBe(.9);
    expect(convert({ anisotropyMap: null }).anisotropyMap).toBeUndefined();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()));
    expect(fromTHREEScene(scene).meshes[0].materials[0].specularAnisotropyModel).toBe('openpbr');
  });
  it('propagates source edits and subsequent native metadata through THREESync', () => {
    const { source, scene } = setup();
    const engine = new Engine({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    const sync = new THREESync(engine, { scene, camera: new THREE.PerspectiveCamera() });
    sync.update();
    const material = engine.scene.meshes[0].materials[0];
    source.anisotropy = .5;
    source.anisotropyRotation = -.3;
    source.anisotropyMap = null;
    sync.update();
    expect(engine.scene.meshes[0].materials[0]).toBe(material);
    expect(material.specularAnisotropy).toBe(.5);
    expect(material.specularAnisotropyRotation).toBe(-.3);
    expect(material.anisotropyMap).toBeUndefined();
    source.userData.mutracerOpenPBR = { specularRoughnessAnisotropy: .2 };
    sync.update();
    expect(material.specularAnisotropyModel).toBe('openpbr');
    expect(material.specularAnisotropyRotation).toBe(0);
    sync.dispose();
    engine.dispose();
  });
});
