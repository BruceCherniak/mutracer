import { describe, expect, it } from 'vitest';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import { Scene } from '../../src/scene/Scene';
import { createCubeGeometry } from '../../src/main';
import RectLight from '../../src/scene/RectLight';
import SpotLight from '../../src/scene/SpotLight';
import EnvironmentLight from '../../src/scene/EnvironmentLight';
import IESProfile from '../../src/scene/IESProfile';

function fixture() {
  const material = new OpenPBRMaterial();
  const mesh = new Mesh(createCubeGeometry(), material);
  const scene: Scene = { meshes: [mesh], lights: [], background: [0,0,0,1] };
  const detector = new SceneChangeDetector();
  detector.detect(scene); detector.commit();
  return { scene, detector, mesh, material };
}
const texture = () => new Texture({ data: new Uint8Array(4), width: 1, height: 1 });

describe('scene change detection', () => {
  it('is stable after commit, preserves uncommitted edits, and resets for a new pipeline', () => {
    const { scene, detector, mesh } = fixture();
    expect(detector.detect(scene)).toEqual({ meshes: 'none', transforms: [], geometries: [], materials: [], lights: false, background: false });
    mesh.matrixWorld[12] = 3;
    const changes = detector.detect(scene);
    expect(changes.meshes).toBe('incremental');
    expect(changes.transforms).toEqual([mesh]);
    expect(detector.detect(scene)).toEqual(changes);
    detector.commit(); expect(detector.detect(scene).meshes).toBe('none');
    detector.reset(); expect(detector.detect(scene).meshes).toBe('full');
  });
  it.each([
    (s: Scene) => { s.meshes = [...s.meshes]; },
    (s: Scene) => { s.meshes.push(new Mesh(createCubeGeometry(), new OpenPBRMaterial())); },
    (s: Scene) => { s.meshes[0] = new Mesh(createCubeGeometry(), new OpenPBRMaterial()); },
    (s: Scene) => { s.meshes[0].geometry = createCubeGeometry(); },
    (s: Scene) => { s.meshes[0].materials.push(new OpenPBRMaterial()); },
    (s: Scene) => { s.meshes[0].materials[0] = new OpenPBRMaterial(); },
    (s: Scene) => { s.meshes[0].geometrySimplificationRatio = 0.5; },
    (s: Scene) => { s.meshes[0].displacementFaceLevels = new Uint8Array([2]); },
    (s: Scene) => { s.meshes[0].displacementFaceLevelsHash++; }
  ])('detects structural edit %s', edit => {
    const { scene, detector } = fixture(); edit(scene);
    expect(detector.detect(scene).meshes).toBe('full');
  });
  it('deduplicates shared materials and detects texture identity/version and direct metadata assignments', () => {
    const { scene, detector, mesh, material } = fixture();
    scene.meshes.push(new Mesh(mesh.geometry, material));
    material.map = texture(); detector.detect(scene); detector.commit();
    material.markUpdated();
    expect(detector.detect(scene).materials).toEqual([material]);
    detector.commit(); material.map.markUpdated();
    expect(detector.detect(scene).materials).toEqual([material]);
    detector.commit(); material.map = texture();
    expect(detector.detect(scene).materials).toEqual([material]);
    detector.commit(); material.map.flipY = true;
    expect(detector.detect(scene).materials).toEqual([material]);
  });
  it('scans light membership, numeric fields, array values, textures and IES identity', () => {
    const { scene, detector } = fixture();
    const spot = new SpotLight([0,1,0], [0,-1,0]);
    const rect = new RectLight(); rect.texture = texture();
    const env = new EnvironmentLight(texture());
    scene.lights.push(spot, rect, env);
    expect(detector.detect(scene).lights).toBe(true); detector.commit();
    for (const edit of [() => { spot.intensity++; }, () => { spot.color[0] = 0.5; },
      () => { rect.matrixWorld[12]++; }, () => { rect.texture!.markUpdated(); },
      () => { env.map.markUpdated(); }, () => { spot.iesProfile = {} as IESProfile; },
      () => { scene.lights = [...scene.lights]; }]) {
      edit(); expect(detector.detect(scene).lights).toBe(true); detector.commit();
      expect(detector.detect(scene).lights).toBe(false);
    }
  });
  it('scans background identity, color components, textures and grounded fields', () => {
    const { scene, detector } = fixture();
    (scene.background as number[])[0] = 0.3;
    expect(detector.detect(scene).background).toBe(true); detector.commit();
    scene.background = texture(); expect(detector.detect(scene).background).toBe(true); detector.commit();
    scene.background.markUpdated(); expect(detector.detect(scene).background).toBe(true); detector.commit();
    scene.background = { type: 'GroundedSkybox', map: texture(), height: 1, radius: 10, center: [0,0] };
    detector.detect(scene); detector.commit();
    for (const edit of [() => { (scene.background as any).height++; },
      () => { (scene.background as any).center[0]++; }, () => { (scene.background as any).map.markUpdated(); }]) {
      edit(); expect(detector.detect(scene).background).toBe(true); detector.commit();
    }
  });
});

it('detects mesh projection overrides as changes requiring instance data updates', async () => {
  const { default: Mesh } = await import('../../src/scene/Mesh');
  const { default: OpenPBRMaterial } = await import('../../src/scene/OpenPBRMaterial');
  const { createCubeGeometry } = await import('../../src/util/commonGeometry');
  const { SceneChangeDetector } = await import('../../src/renderer/sceneChangeDetector');
  const mesh = new Mesh(createCubeGeometry(),new OpenPBRMaterial());
  const scene = { meshes: [mesh], lights: [] }; const d = new SceneChangeDetector();
  d.detect(scene); d.commit(); mesh.uvProjection='triplanar'; expect(d.detect(scene).meshes).toBe('full'); d.commit();
  mesh.displacementUvProjection='spherical'; expect(d.detect(scene).meshes).toBe('full');
});


it('keeps reporting the latest uncommitted pose and material versions throughout animation', () => {
  const { scene, detector, mesh, material } = fixture();
  for (let frame = 1; frame <= 200; frame++) {
    mesh.matrixWorld[12] = frame;
    material.markUpdated();
    const first = detector.detect(scene);
    expect(first.transforms).toEqual([mesh]); expect(first.materials).toEqual([material]);
    mesh.matrixWorld[13] = frame * 2;
    expect(detector.detect(scene)).toEqual(first);
    detector.commit();
    expect(detector.detect(scene).meshes).toBe('none');
  }
  scene.meshes.push(new Mesh(mesh.geometry, material));
  expect(detector.detect(scene).meshes).toBe('full'); detector.commit();
  mesh.matrixWorld[14] = 7;
  expect(detector.detect(scene).transforms).toEqual([mesh]); detector.commit();
  expect(detector.detect(scene).meshes).toBe('none');
});


it('reports shared geometry versions incrementally and storage/schema changes as full', () => {
  const { scene, detector, mesh } = fixture();
  scene.meshes.push(new Mesh(mesh.geometry, mesh.materials[0])); detector.detect(scene); detector.commit();
  mesh.geometry.markUpdated(); const change = detector.detect(scene);
  expect(change.meshes).toBe('incremental'); expect(change.geometries).toEqual([mesh.geometry]);
  expect(detector.detect(scene)).toEqual(change); detector.commit();
  for (const name of ['position', 'normal', 'indices'] as const) {
    const attribute = mesh.geometry[name]; attribute.array = attribute.array.slice();
    expect(detector.detect(scene).meshes).toBe('full'); detector.commit();
  }
  mesh.geometry.dynamic = true; expect(detector.detect(scene).meshes).toBe('full');
});
