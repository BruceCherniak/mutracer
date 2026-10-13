import RenderLoop from '../../src/RenderLoop';
import { renderFixture } from '../helpers/renderPipeline';
import Engine from '../../src/Engine';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { THREESync, fromTHREEScene } from '../../src/util/fromTHREE';
import Texture from '../../src/scene/Texture';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import SphereLight from '../../src/scene/SphereLight';

function fixture() {
  const source = new THREE.Scene();
  const map = new THREE.Texture({ width: 2, height: 2 });
  const material = new THREE.MeshStandardMaterial({ map });
  const geometry = new THREE.BoxGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  const light = new THREE.PointLight(0xffffff, 2);
  source.add(mesh, new THREE.Mesh(geometry, material), light);
  source.background = new THREE.Color(0x102030);
  const sync = initializedSync(source);
  return { source, map, material, geometry, mesh, light, sync };
}

describe('THREESync', () => {
  it('retains scene, arrays and shared mesh resources on unchanged updates', () => {
    const { sync } = fixture();
    const scene = sync.scene;
    const meshes = scene.meshes, lights = scene.lights, background = scene.background;
    const [first, second] = meshes;
    const material = first.materials[0], texture = material.map;
    expect(second.materials[0]).toBe(material);
    expect(second.geometry).toBe(first.geometry);
    expect(sync.update()).toBeUndefined();
    expect(sync.scene).toBe(scene);
    expect(scene.meshes).toBe(meshes); expect(scene.lights).toBe(lights);
    expect(scene.background).toBe(background);
    expect(scene.meshes[0]).toBe(first);
    expect(first.materials[0]).toBe(material); expect(material.map).toBe(texture);
    expect(material.version).toBe(0);
  });

  it('updates only the existing matrix when rotating a mesh', () => {
    const { sync, mesh } = fixture();
    const converted = sync.scene.meshes[0];
    const matrix = converted.transform, geometry = converted.geometry;
    const before = [...matrix];
    mesh.rotation.y = 0.5;
    sync.update();
    expect(converted.transform).toBe(matrix);
    expect(matrix).not.toEqual(before); expect(converted.geometry).toBe(geometry);
    sync.update();
  });

  it('updates a shared material once when editing color without needsUpdate', () => {
    const { sync, material } = fixture();
    const converted = sync.scene.meshes[0].materials[0];
    material.color.setRGB(0.3, 0.4, 0.5);
    sync.update();
    expect(sync.scene.meshes[0].materials[0]).toBe(converted);
    expect(sync.scene.meshes[1].materials[0]).toBe(converted);
    expect(converted.baseColor).toEqual([0.3, 0.4, 0.5]);
    expect(converted.version).toBe(1);
    sync.update(); expect(converted.version).toBe(1);
  });

  it('refreshes a texture in place by version, image and UV metadata', () => {
    const { sync, map } = fixture();
    const converted = sync.scene.meshes[0].materials[0].map!;
    const before = converted.version;
    map.needsUpdate = true;
    sync.update();
    expect(sync.scene.meshes[0].materials[0].map).toBe(converted);
    expect(converted.version).toBe(before + 1);
    map.image = { width: 4, height: 4 };
    map.repeat.set(2, 3); map.offset.set(0.2, 0.1); map.channel = 1;
    sync.update();
    expect(converted.image).toBe(map.image); expect(converted.uvScale).toEqual([2, 3]);
    expect(converted.uvOffset).toEqual([0.2, 0.1]); expect(converted.uvChannel).toBe(1);
    sync.update();
  });

  it.each(['position', 'normal', 'tangent', 'uv', 'uv1', 'index'])('invalidates geometry after %s attribute updates and replacement', name => {
    const { sync, geometry } = fixture();
    if (name === 'tangent' || name === 'uv1') {
      geometry.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * (name === 'tangent' ? 4 : 2)), name === 'tangent' ? 4 : 2));
      sync.update();
    }
    const old = sync.scene.meshes[0].geometry;
    const attribute = name === 'index' ? geometry.index! : geometry.getAttribute(name) as THREE.BufferAttribute;
    attribute.setX(0, attribute.getX(0) + 0.2); attribute.needsUpdate = true;
    sync.update();
    expect(sync.scene.meshes[0].geometry).not.toBe(old);
    expect(sync.scene.meshes[1].geometry).toBe(sync.scene.meshes[0].geometry);
    const edited = sync.scene.meshes[0].geometry;
    if (name === 'index') geometry.setIndex(attribute.clone());
    else geometry.setAttribute(name, attribute.clone());
    sync.update(); expect(sync.scene.meshes[0].geometry).not.toBe(edited);
  });

  it('tracks interleaved buffer versions', () => {
    const { sync, geometry } = fixture();
    const oldPosition = geometry.getAttribute('position');
    const data = new THREE.InterleavedBuffer(new Float32Array(oldPosition.array), 3);
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(data, 3, 0));
    sync.update(); const old = sync.scene.meshes[0].geometry;
    data.array[0] += 0.1; data.needsUpdate = true;
    sync.update();
    expect(sync.scene.meshes[0].geometry).not.toBe(old);
  });

  it.each(['array', 'count', 'itemSize', 'normalized'] as const)('detects %s edits without an attribute version bump', field => {
    const { sync, geometry } = fixture();
    const attribute = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const old = sync.scene.meshes[0].geometry;
    const version = attribute.version;
    if (field === 'array') {
      attribute.array = new Float32Array(attribute.array);
      attribute.array[0] = 0.25;
    } else if (field === 'count') Object.defineProperty(attribute, 'count', { value: attribute.count - 1 });
    else if (field === 'itemSize') attribute.itemSize = 1;
    else attribute.normalized = true;
    expect(attribute.version).toBe(version);
    sync.update();
    expect(sync.scene.meshes[0].geometry).not.toBe(old);
    expect(sync.scene.meshes[1].geometry).toBe(sync.scene.meshes[0].geometry);
    if (field === 'array') expect(sync.scene.meshes[0].geometry.uv!.array[0]).toBe(0.25);
    if (field === 'itemSize') expect(sync.scene.meshes[0].geometry.uv!.itemSize).toBe(1);
    sync.update();
  });

  it.each(['offset', 'stride', 'buffer', 'array'] as const)('detects interleaved %s edits without a version bump', field => {
    const { sync, geometry } = fixture();
    const original = geometry.getAttribute('uv');
    const pixels = new Float32Array(original.count * 4);
    for (let i = 0; i < original.count; i++) pixels.set([original.getX(i), original.getY(i), 0.25, 0.75], i * 4);
    const data = new THREE.InterleavedBuffer(pixels, 4);
    const uv = new THREE.InterleavedBufferAttribute(data, 2, 0);
    geometry.setAttribute('uv', uv);
    sync.update();
    const old = sync.scene.meshes[0].geometry;
    if (field === 'offset') uv.offset = 2;
    else if (field === 'stride') data.stride = 2;
    else if (field === 'buffer') uv.data = new THREE.InterleavedBuffer(pixels, 4);
    else {
      data.array = new Float32Array(pixels);
      data.array[0] = 0.5;
    }
    expect(uv.data.version).toBe(0);
    sync.update();
    expect(sync.scene.meshes[0].geometry).not.toBe(old);
    expect(sync.scene.meshes[1].geometry).toBe(sync.scene.meshes[0].geometry);
    if (field === 'offset') expect(Array.from(sync.scene.meshes[0].geometry.uv!.array.slice(0, 2))).toEqual([0.25, 0.75]);
    if (field === 'array') expect(sync.scene.meshes[0].geometry.uv!.array[0]).toBe(0.5);
    sync.update();
  });

  it('invalidates all shared groups when optional attributes are removed and restored', () => {
    const { sync, source, geometry, material } = fixture();
    for (const mesh of source.children.filter((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh)) {
      mesh.material = [material, new THREE.MeshStandardMaterial()];
    }
    geometry.clearGroups(); geometry.addGroup(0, 18, 0); geometry.addGroup(18, 18, 1);
    sync.update();
    const uv = geometry.getAttribute('uv');
    const old = sync.scene.meshes.map(mesh => mesh.geometry);
    geometry.deleteAttribute('uv');
    sync.update();
    for (let i = 0; i < 4; i++) {
      expect(sync.scene.meshes[i].geometry).not.toBe(old[i]);
      expect(sync.scene.meshes[i].geometry.uv).toBeUndefined();
      expect(sync.scene.meshes[i].geometry).toBe(sync.scene.meshes[i % 2].geometry);
    }
    const removed = sync.scene.meshes.map(mesh => mesh.geometry);
    geometry.setAttribute('uv', uv);
    sync.update();
    for (let i = 0; i < 4; i++) {
      expect(sync.scene.meshes[i].geometry).not.toBe(removed[i]);
      expect(sync.scene.meshes[i].geometry.uv!.array).toEqual(uv.array);
    }
    sync.update();
  });

  it('checks shared geometry once per update across meshes, groups and instances', () => {
    const source = new THREE.Scene();
    const geometry = new THREE.BoxGeometry();
    geometry.clearGroups(); geometry.addGroup(0, 18, 0); geometry.addGroup(18, 18, 1);
    const materials = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    source.add(new THREE.Mesh(geometry, materials), new THREE.Mesh(geometry, materials),
      new THREE.InstancedMesh(geometry, materials, 3));
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
    let version = normal.version, reads = 0;
    Object.defineProperty(normal, 'version', {
      get: () => { reads++; return version; },
      set: (value: number) => { version = value; }
    });
    const sync = initializedSync(source);
    expect(sync.scene.meshes).toHaveLength(6);
    for (let i = 0; i < 3; i++) {
      reads = 0;
      sync.update();
      expect(reads).toBe(1);
    }
    const old = sync.scene.meshes[0].geometry;
    normal.setXYZ(0, 0, 1, 0); normal.needsUpdate = true;
    sync.update();
    for (let i = 0; i < 6; i++) {
      const groupIndex = i % 2;
      expect(sync.scene.meshes[i].geometry).toBe(sync.scene.meshes[groupIndex].geometry);
      expect(sync.scene.meshes[i].geometry.normal.array.slice(0, 3)).toEqual(new Float32Array([0, 1, 0]));
    }
    expect(sync.scene.meshes[0].geometry).not.toBe(old);
    reads = 0;
    sync.update();
    expect(reads).toBe(1);
  });

  it('reuses meshes when visibility or group membership changes', () => {
    const { sync, mesh } = fixture();
    const first = sync.scene.meshes[0]; mesh.visible = false;
    sync.update();
    expect(sync.scene.meshes).not.toContain(first);
    mesh.visible = true; sync.update(); expect(sync.scene.meshes[0]).toBe(first);
    (mesh as THREE.Mesh).material = [mesh.material as THREE.Material, new THREE.MeshStandardMaterial()];
    mesh.geometry.clearGroups(); mesh.geometry.addGroup(0, 3, 0); mesh.geometry.addGroup(3, 3, 1);
    sync.update(); const group = sync.scene.meshes[1];
    expect(sync.scene.meshes[0]).toBe(first);
    mesh.visible = false; sync.update(); mesh.visible = true; sync.update();
    expect(sync.scene.meshes[1]).toBe(group);
  });

  it('skips hidden subtrees and restores retained meshes and lights with current values', () => {
    const source = new THREE.Scene();
    const parent = new THREE.Group(), nested = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const light = new THREE.PointLight(0xffffff, 2);
    nested.add(mesh, light); parent.add(nested); source.add(parent);
    const convertedSources: THREE.Mesh[] = [];
    const sync = initializedSync(source, { onMeshConverted: (_, sourceMesh) => convertedSources.push(sourceMesh) });
    const convertedMesh = sync.scene.meshes[0], convertedLight = sync.scene.lights[0];
    for (const hiddenRoot of [parent, nested, source]) {
      convertedSources.length = 0;
      hiddenRoot.visible = false;
      sync.update();
      expect(sync.scene.meshes).toHaveLength(0); expect(sync.scene.lights).toHaveLength(0);
      expect(convertedSources).toHaveLength(0);
      mesh.position.x++; light.intensity++;
      sync.update();
      expect(convertedSources).toHaveLength(0);
      hiddenRoot.visible = true;
      sync.update();
      expect(sync.scene.meshes).toEqual([convertedMesh]); expect(sync.scene.lights).toEqual([convertedLight]);
      expect(sync.scene.meshes[0]).toBe(convertedMesh); expect(sync.scene.lights[0]).toBe(convertedLight);
      expect(convertedMesh.transform[12]).toBe(mesh.position.x);
      expect(convertedLight.type === 'SphereLight' && convertedLight.intensity).toBe(light.intensity);
      expect(convertedSources).toEqual([mesh]);
      sync.update();
    }
  });

  it('updates lights and background without replacing their unchanged identities', () => {
    const { sync, light, source } = fixture();
    const lights = sync.scene.lights, converted = lights[0], background = sync.scene.background;
    light.intensity = 4; light.position.x = 1;
    sync.update();
    expect(sync.scene.lights).toBe(lights); expect(lights[0]).toBe(converted);
    expect(converted.type === 'SphereLight' && converted.intensity).toBe(4);
    (source.background as THREE.Color).setRGB(0.2, 0.3, 0.4);
    sync.update();
    expect(sync.scene.background).not.toBe(background);
    const updated = sync.scene.background; sync.update(); expect(sync.scene.background).toBe(updated);
  });

  it('retains an environment light and the shared background texture on pixel edits', () => {
    const source = new THREE.Scene();
    const pixels = new Float32Array([0.2, 0.3, 0.4, 1]);
    const texture = new THREE.DataTexture(pixels, 1, 1, THREE.RGBAFormat, THREE.FloatType);
    source.environment = source.background = texture;
    const sync = initializedSync(source);
    const light = sync.scene.lights[0]; const map = sync.scene.background as Texture;
    pixels[0] = 0.7; texture.needsUpdate = true;
    sync.update();
    expect(sync.scene.lights[0]).toBe(light); expect(sync.scene.background).toBe(map);
    expect(light.type === 'EnvironmentLight' && light.map).toBe(map);
    expect((map.image as { data: Float32Array }).data[0]).toBe(Math.fround(0.7));
    sync.update();
  });

  it('creates fresh resources across one-shot calls and supports disposal', () => {
    const { source, sync } = fixture();
    const a = fromTHREEScene(source), b = fromTHREEScene(source);
    expect(a.meshes).not.toBe(b.meshes); expect(a.meshes[0]).not.toBe(b.meshes[0]);
    expect(a.meshes[0].geometry).not.toBe(b.meshes[0].geometry);
    expect(a.meshes[0].materials[0]).not.toBe(b.meshes[0].materials[0]);
    expect(a.meshes[0].materials[0].map).not.toBe(b.meshes[0].materials[0].map);
    sync.dispose(); sync.dispose(); expect(() => sync.update()).toThrow('disposed');
    expect(sync.scene.meshes).toHaveLength(2);
  });
});

it('retains the converted source material for UV meshes and shares automatic projection variants', () => {
  const source = new THREE.Scene();
  const map = new THREE.Texture({ width: 2, height: 2 });
  const material = new THREE.MeshStandardMaterial({ map, displacementMap: map });
  const uv = new THREE.BoxGeometry(), uvless = new THREE.BoxGeometry(); uvless.deleteAttribute('uv');
  const fallback = new THREE.Mesh(uvless, material), secondFallback = new THREE.Mesh(uvless, material);
  source.add(new THREE.Mesh(uv, material), fallback, secondFallback, new THREE.Mesh(uv, material));
  const sync = initializedSync(source); const [a, b, c, d] = sync.scene.meshes;
  const base = a.materials[0], variant = b.materials[0];
  expect(base).toBe(d.materials[0]); expect(variant).toBe(c.materials[0]); expect(variant).not.toBe(base);
  expect(base.uvProjection).toBe('none'); expect(base.displacementUvProjection).toBe('none');
  expect(variant.uvProjection).toBe('triplanar'); expect(variant.displacementUvProjection).toBe('triplanar');
  expect(a).not.toHaveProperty('uvProjection'); expect(b).not.toHaveProperty('displacementUvProjection');
  sync.update();
  const baseVersion = base.version, variantVersion = variant.version;
  material.roughness = .7; material.color.setRGB(.2, .4, .6); material.opacity = .5;
  sync.update();
  for (const converted of [base, variant]) {
    expect(converted.specularRoughness).toBe(.7); expect(converted.baseColor).toEqual([.2, .4, .6]);
    expect(converted.opacity).toBe(.5); expect(converted.map).toBe(base.map);
  }
  expect(a.materials[0]).toBe(base); expect(b.materials[0]).toBe(variant);
  expect(base.version).toBe(baseVersion + 1); expect(variant.version).toBe(variantVersion + 1);
  const cache = (sync as unknown as { _store: { colorVariants: Map<THREE.Material, Map<string, unknown>> } })._store.colorVariants;
  expect(cache.get(material)!.size).toBe(1);
  source.remove(fallback, secondFallback); sync.update(); expect(cache.size).toBe(0);
});

it('respects explicit material projections and prunes superseded automatic variants', () => {
  const source = new THREE.Scene(), map = new THREE.Texture({ width: 2, height: 2 });
  const material = new THREE.MeshStandardMaterial({ map, displacementMap: map });
  const uvless = new THREE.BoxGeometry(); uvless.deleteAttribute('uv');
  source.add(new THREE.Mesh(new THREE.BoxGeometry(), material), new THREE.Mesh(uvless, material));
  const sync = initializedSync(source), [a, b] = sync.scene.meshes;
  const cache = (sync as unknown as { _store: { colorVariants: Map<THREE.Material, Map<string, unknown>> } })._store.colorVariants;
  const initial = b.materials[0];
  material.userData.mutracerUvProjection = 'spherical'; sync.update();
  expect(a.materials[0].uvProjection).toBe('spherical'); expect(b.materials[0].uvProjection).toBe('spherical');
  expect(b.materials[0].displacementUvProjection).toBe('triplanar'); expect(b.materials[0]).not.toBe(initial);
  expect(cache.get(material)!.size).toBe(1);
  material.userData.mutracerDisplacementUvProjection = 'cylindrical'; sync.update();
  expect(b.materials[0]).toBe(a.materials[0]); expect(cache.size).toBe(0);
  material.userData.mutracerUvProjection = 'none'; material.userData.mutracerDisplacementUvProjection = 'none';
  sync.update(); expect(cache.get(material)!.size).toBe(1);
  material.map = material.displacementMap = null; sync.update();
  expect(b.materials[0]).toBe(a.materials[0]); expect(cache.size).toBe(0);
});


it('retains Three.js matrix precision before CPU inverse transforms', () => {
  const { mesh, sync } = fixture();
  const matrix = sync.scene.meshes[0].transform;
  mesh.position.set(0.123456789123, 0.234567891234, 0.345678912345);
  mesh.rotation.set(0.123456789123, 0.234567891234, 0.345678912345);
  mesh.scale.set(0.123456789123, 0.234567891234, 0.345678912345);
  sync.update();
  expect(sync.scene.meshes[0].transform).toBe(matrix);
  expect(Array.from(matrix)).toEqual(mesh.matrixWorld.elements);
  expect(matrix[12]).not.toBe(Math.fround(mesh.matrixWorld.elements[12]));
});

function initializedSync(scene: THREE.Scene, options: import('../../src/util/fromTHREE').FromTHREESceneOptions = {}) {
  const sync = new THREESync(new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}), {scene, ...options});
  sync.update(); return sync as THREESync & {scene: NonNullable<THREESync['scene']>};
}

describe('THREESync engine and interaction contract', () => {
  function controls(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    const listeners = new Map<string, () => void>();
    return {target: new THREE.Vector3(), enableDamping: true, autoRotate: false,
      update: vi.fn(() => false),
      addEventListener: vi.fn((name: 'start' | 'end', listener: () => void) => listeners.set(name, listener)),
      removeEventListener: vi.fn((name: 'start' | 'end', listener: () => void) => {if (listeners.get(name) === listener) listeners.delete(name);}),
      fire(name: string) {listeners.get(name)!();}, camera};
  }
  it('subscribes at construction and writes sources only on the first update', () => {
    const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement});
    const source = new THREE.Scene(), camera = new THREE.PerspectiveCamera(); const control = controls(camera);
    const sync = new THREESync(engine, {scene: source, camera, controls: control});
    expect(engine.scene).toBeUndefined(); expect(engine.camera).toBeUndefined(); expect(control.update).not.toHaveBeenCalled();
    sync.update(); const converted = engine.camera;
    expect(engine.scene).toBe(sync.scene); expect(converted).toBeDefined(); expect(sync.active).toBe(false);
    camera.position.x = 1; sync.update(); expect(sync.active).toBe(true); expect(engine.camera).toBe(converted);
    sync.update(); expect(sync.active).toBe(false);
    sync.dispose(); sync.dispose(); expect(control.removeEventListener).toHaveBeenCalledTimes(2); engine.dispose();
  });
  it('supports camera-only and empty sources without replacing the engine scene', () => {
    const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}); const scene = {meshes: [], lights: []}; engine.scene = scene;
    const sync = new THREESync(engine, {camera: new THREE.PerspectiveCamera()}); sync.update(); expect(engine.scene).toBe(scene);
    const camera = engine.camera; new THREESync(engine).update(); expect(engine.camera).toBe(camera); expect(engine.scene).toBe(scene); sync.dispose(); engine.dispose();
  });
  it('respects start/end and terminates a small damping tail in the ending tick', () => {
    const {engine, targets} = renderFixture({tiles: 2, fits: false}); const camera = new THREE.PerspectiveCamera(); camera.position.z = 5;
    const control = controls(camera); const sync = new THREESync(engine, {camera, controls: control});
    const loop = new RenderLoop(engine, {sync}); control.fire('start'); loop.tick();
    const trace = vi.mocked(targets[0].trace).getMockImplementation()!;
    vi.mocked(targets[0].trace).mockImplementation((camera, cap) => {trace(camera, cap); return trace(camera, cap);});
    loop.tick(); expect(loop.status).toBe('previewing');
    control.fire('end'); control.update.mockImplementation(() => {if (control.enableDamping) camera.position.x += .01; return true;});
    loop.tick(); expect(loop.changing).toBe(true);
    control.update.mockImplementation(() => {if (control.enableDamping) camera.position.x += .0001; return true;});
    expect(loop.tick()).toBe('previewing'); expect(loop.changing).toBe(false); expect(control.enableDamping).toBe(true);
    expect(targets[1].trace).toHaveBeenCalledOnce();
    control.update.mockReturnValue(false); expect(loop.tick()).toBe('converging'); loop.dispose(); sync.dispose(); engine.dispose();
  });
  it('ends orthographic zoom damping as well as positional movement', () => {
    const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}); const camera = new THREE.OrthographicCamera(); camera.position.z = 5;
    const control = controls(camera); const sync = new THREESync(engine, {camera, controls: control}); sync.update();
    control.update.mockImplementation(() => {if (control.enableDamping) camera.zoom *= 1.01; return true;}); sync.update(); expect(sync.active).toBe(true);
    control.update.mockImplementation(() => {if (control.enableDamping) camera.zoom *= 1.0001; return true;}); sync.update(); expect(sync.active).toBe(false); sync.dispose(); engine.dispose();
  });
  it('does not call controls.update when updateControls is false', () => {
    const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}); const camera = new THREE.PerspectiveCamera(); const control = controls(camera);
    const sync = new THREESync(engine, {camera, controls: control, updateControls: false}); control.fire('start'); expect(sync.active).toBe(true); sync.update(); expect(sync.active).toBe(true);
    control.fire('end'); sync.update(); expect(sync.active).toBe(false); expect(control.update).not.toHaveBeenCalled(); sync.dispose(); engine.dispose();
  });
  it('marks changed morph poses active for just that update', () => {
    const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}); const source = new THREE.Scene();
    const geometry = new THREE.BoxGeometry(); geometry.morphAttributes.position = [geometry.attributes.position.clone()]; geometry.morphTargetsRelative = true;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()); source.add(mesh);
    const sync = new THREESync(engine, {scene: source}); sync.update(); sync.update(); expect(sync.active).toBe(false);
    mesh.morphTargetInfluences![0] = .5; sync.update(); expect(sync.active).toBe(true); sync.update(); expect(sync.active).toBe(false); sync.dispose(); engine.dispose();
  });
});

describe('persistent conversion hooks', () => {
  it('caches shared custom materials by source identity/version and retains caller edits', () => {
    const source = new THREE.Scene(); const material = new THREE.ShaderMaterial(); const geometry = new THREE.BoxGeometry();
    const mesh = new THREE.Mesh(geometry, material); source.add(mesh, new THREE.Mesh(geometry, material));
    const custom = new OpenPBRMaterial(); const hook = vi.fn(() => custom);
    const engine = new Engine({canvas: {width: 10,height: 10} as HTMLCanvasElement});
    const sync = new THREESync(engine, {scene: source, convertMaterial: hook});
    expect(hook).not.toHaveBeenCalled(); sync.update(); sync.update();
    expect(hook).toHaveBeenCalledOnce(); expect(hook).toHaveBeenCalledWith(material);
    expect(sync.scene!.meshes.map(m => m.materials[0])).toEqual([custom,custom]);
    custom.baseColor = [.2,.3,.4]; custom.markUpdated(); sync.update();
    expect(hook).toHaveBeenCalledOnce(); expect(sync.scene!.meshes[0].materials[0]).toBe(custom);
    expect(custom.baseColor).toEqual([.2,.3,.4]); expect(custom.version).toBe(1);
    material.needsUpdate = true; sync.update(); expect(hook).toHaveBeenCalledTimes(2);
    source.remove(mesh); sync.update(); source.add(mesh); sync.update(); expect(hook).toHaveBeenCalledTimes(2);
    sync.dispose(); engine.dispose();
  });
  it('caches undefined results but continues default parameter conversion without needsUpdate', () => {
    const source = new THREE.Scene(); const material = new THREE.MeshStandardMaterial(); source.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const hook = vi.fn(() => undefined); const engine = new Engine({canvas: {width: 10,height: 10} as HTMLCanvasElement});
    const sync = new THREESync(engine, {scene: source, convertMaterial: hook}); sync.update();
    const converted = sync.scene!.meshes[0].materials[0]; material.roughness = .2; sync.update();
    expect(hook).toHaveBeenCalledOnce(); expect(sync.scene!.meshes[0].materials[0]).toBe(converted); expect(converted.specularRoughness).toBe(.2);
    material.needsUpdate = true; sync.update(); expect(hook).toHaveBeenCalledTimes(2); sync.dispose(); engine.dispose();
  });
  it('caches null materials and allows conversion to resume after a version change', () => {
    const source = new THREE.Scene(); const material = new THREE.MeshStandardMaterial(); source.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const custom = new OpenPBRMaterial(); let result: OpenPBRMaterial | null = null; const hook = vi.fn(() => result);
    const engine = new Engine({canvas: {width: 10,height: 10} as HTMLCanvasElement});
    const sync = new THREESync(engine, {scene: source, convertMaterial: hook}); sync.update(); sync.update();
    expect(sync.scene!.meshes).toEqual([]); expect(hook).toHaveBeenCalledOnce();
    result = custom; material.needsUpdate = true; sync.update(); expect(sync.scene!.meshes[0].materials[0]).toBe(custom);
    result = null; material.needsUpdate = true; sync.update(); expect(sync.scene!.meshes).toEqual([]); expect(hook).toHaveBeenCalledTimes(3);
    sync.dispose(); engine.dispose();
  });
  it('refreshes color and automatic-projection variants on custom edits and equal-version replacement', () => {
    const source = new THREE.Scene(); const material = new THREE.ShaderMaterial(); const geometry = new THREE.BoxGeometry(); geometry.deleteAttribute('uv');
    const mesh = new THREE.InstancedMesh(geometry, material, 2); mesh.setColorAt(0, new THREE.Color(.5,1,1)); mesh.setColorAt(1, new THREE.Color(.5,1,1)); source.add(mesh);
    const map = new Texture({width: 1,height: 1,data: new Uint8Array(4)});
    let custom = new OpenPBRMaterial({baseColor: [.8,.6,.4], map});
    const engine = new Engine({canvas: {width: 10,height: 10} as HTMLCanvasElement});
    const sync = new THREESync(engine, {scene: source, convertMaterial: () => custom}); sync.update();
    const variant = sync.scene!.meshes[0].materials[0];
    expect(variant).not.toBe(custom); expect(sync.scene!.meshes).toHaveLength(1);
    expect((sync.scene!.meshes[0] as import('../../src/scene/InstancedMesh').default).count).toBe(2);
    expect(variant.baseColor).toEqual([.4,.6,.4]); expect(variant.uvProjection).toBe('triplanar');
    custom.baseColor = [.4,.3,.2]; custom.markUpdated(); sync.update(); expect(variant.baseColor).toEqual([.2,.3,.2]);
    custom = new OpenPBRMaterial({baseColor: [.2,.1,.6], map}); custom.markUpdated();
    material.needsUpdate = true; sync.update(); expect(sync.scene!.meshes[0].materials[0]).toBe(variant);
    expect(variant.baseColor).toEqual([.1,.1,.6]); expect(variant.uvProjection).toBe('triplanar');
    sync.dispose(); engine.dispose();
  });
  it('caches lights without a native version, handles explicit revisions and keeps returned identity', () => {
    const source = new THREE.Scene(); const light = new THREE.HemisphereLight(); source.add(light);
    const custom = new SphereLight({intensity: 2}); let result: SphereLight | null | undefined = custom;
    const hook = vi.fn(() => result); const engine = new Engine({canvas: {width: 10,height: 10} as HTMLCanvasElement});
    const sync = new THREESync(engine, {scene: source, convertLight: hook}); sync.update(); sync.update();
    expect(hook).toHaveBeenCalledOnce(); expect(sync.scene!.lights[0]).toBe(custom);
    custom.intensity = 5; light.intensity = 10; sync.update(); expect(custom.intensity).toBe(5); expect(hook).toHaveBeenCalledOnce();
    result = null; light.userData.mutracerVersion = 1; sync.update(); sync.update(); expect(sync.scene!.lights).toEqual([]); expect(hook).toHaveBeenCalledTimes(2);
    result = custom; light.userData.mutracerVersion = 2; sync.update(); expect(sync.scene!.lights[0]).toBe(custom); expect(hook).toHaveBeenCalledTimes(3);
    sync.dispose(); engine.dispose();
  });
  it('caches light fallback decisions while continuing built-in light edits', () => {
    const source = new THREE.Scene(); const light = new THREE.PointLight(); source.add(light);
    const hook = vi.fn(() => undefined); const engine = new Engine({canvas: {width: 10,height: 10} as HTMLCanvasElement});
    const sync = new THREESync(engine, {scene: source, convertLight: hook}); sync.update();
    const converted = sync.scene!.lights[0]; light.intensity = 7; sync.update();
    expect(hook).toHaveBeenCalledOnce(); expect(sync.scene!.lights[0]).toBe(converted); expect(converted).toMatchObject({intensity: 7});
    light.userData.mutracerVersion = 1; sync.update(); expect(hook).toHaveBeenCalledTimes(2); sync.dispose(); engine.dispose();
  });
});
