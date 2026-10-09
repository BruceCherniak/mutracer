import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { THREESceneSync, fromTHREEScene } from '../../src/util/fromTHREE';
import Texture from '../../src/scene/Texture';

function fixture() {
  const source = new THREE.Scene();
  const map = new THREE.Texture({ width: 2, height: 2 });
  const material = new THREE.MeshStandardMaterial({ map });
  const geometry = new THREE.BoxGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  const light = new THREE.PointLight(0xffffff, 2);
  source.add(mesh, new THREE.Mesh(geometry, material), light);
  source.background = new THREE.Color(0x102030);
  const sync = new THREESceneSync(source);
  return { source, map, material, geometry, mesh, light, sync };
}
const unchanged = { transforms: 0, membership: false, content: false, lights: false, background: false };

describe('THREESceneSync', () => {
  it('retains scene, arrays and shared mesh resources on unchanged updates', () => {
    const { sync } = fixture();
    const scene = sync.scene;
    const meshes = scene.meshes, lights = scene.lights, background = scene.background;
    const [first, second] = meshes;
    const material = first.materials[0], texture = material.map;
    expect(second.materials[0]).toBe(material);
    expect(second.geometry).toBe(first.geometry);
    expect(sync.update()).toEqual(unchanged);
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
    const matrix = converted.matrixWorld, geometry = converted.geometry;
    const before = [...matrix];
    mesh.rotation.y = 0.5;
    expect(sync.update()).toEqual({ ...unchanged, transforms: 1 });
    expect(converted.matrixWorld).toBe(matrix);
    expect(matrix).not.toEqual(before); expect(converted.geometry).toBe(geometry);
    expect(sync.update()).toEqual(unchanged);
  });

  it('updates a shared material once when editing color without needsUpdate', () => {
    const { sync, material } = fixture();
    const converted = sync.scene.meshes[0].materials[0];
    material.color.setRGB(0.3, 0.4, 0.5);
    expect(sync.update()).toEqual({ ...unchanged, content: true });
    expect(sync.scene.meshes[0].materials[0]).toBe(converted);
    expect(sync.scene.meshes[1].materials[0]).toBe(converted);
    expect(converted.baseColor).toEqual([0.3, 0.4, 0.5]);
    expect(converted.version).toBe(1);
    expect(sync.update()).toEqual(unchanged); expect(converted.version).toBe(1);
  });

  it('refreshes a texture in place by version, image and UV metadata', () => {
    const { sync, map } = fixture();
    const converted = sync.scene.meshes[0].materials[0].map!;
    const before = converted.version;
    map.needsUpdate = true;
    expect(sync.update().content).toBe(true);
    expect(sync.scene.meshes[0].materials[0].map).toBe(converted);
    expect(converted.version).toBe(before + 1);
    map.image = { width: 4, height: 4 };
    map.repeat.set(2, 3); map.offset.set(0.2, 0.1); map.channel = 1;
    sync.update();
    expect(converted.image).toBe(map.image); expect(converted.uvScale).toEqual([2, 3]);
    expect(converted.uvOffset).toEqual([0.2, 0.1]); expect(converted.uvChannel).toBe(1);
    expect(sync.update()).toEqual(unchanged);
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
    expect(sync.update().content).toBe(true);
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
    expect(sync.update().content).toBe(true);
    expect(sync.scene.meshes[0].geometry).not.toBe(old);
  });

  it('reuses meshes when visibility or group membership changes', () => {
    const { sync, mesh } = fixture();
    const first = sync.scene.meshes[0]; mesh.visible = false;
    expect(sync.update().membership).toBe(true);
    expect(sync.scene.meshes).not.toContain(first);
    mesh.visible = true; sync.update(); expect(sync.scene.meshes[0]).toBe(first);
    (mesh as THREE.Mesh).material = [mesh.material as THREE.Material, new THREE.MeshStandardMaterial()];
    mesh.geometry.clearGroups(); mesh.geometry.addGroup(0, 3, 0); mesh.geometry.addGroup(3, 3, 1);
    sync.update(); const group = sync.scene.meshes[1];
    expect(sync.scene.meshes[0]).toBe(first);
    mesh.visible = false; sync.update(); mesh.visible = true; sync.update();
    expect(sync.scene.meshes[1]).toBe(group);
  });

  it('updates lights and background without replacing their unchanged identities', () => {
    const { sync, light, source } = fixture();
    const lights = sync.scene.lights, converted = lights[0], background = sync.scene.background;
    light.intensity = 4; light.position.x = 1;
    expect(sync.update()).toEqual({ ...unchanged, lights: true });
    expect(sync.scene.lights).toBe(lights); expect(lights[0]).toBe(converted);
    expect(converted.type === 'SphereLight' && converted.intensity).toBe(4);
    (source.background as THREE.Color).setRGB(0.2, 0.3, 0.4);
    expect(sync.update().background).toBe(true);
    expect(sync.scene.background).not.toBe(background);
    const updated = sync.scene.background; sync.update(); expect(sync.scene.background).toBe(updated);
  });

  it('retains an environment light and the shared background texture on pixel edits', () => {
    const source = new THREE.Scene();
    const pixels = new Float32Array([0.2, 0.3, 0.4, 1]);
    const texture = new THREE.DataTexture(pixels, 1, 1, THREE.RGBAFormat, THREE.FloatType);
    source.environment = source.background = texture;
    const sync = new THREESceneSync(source);
    const light = sync.scene.lights[0]; const map = sync.scene.background as Texture;
    pixels[0] = 0.7; texture.needsUpdate = true;
    expect(sync.update()).toEqual({ ...unchanged, lights: true, background: true });
    expect(sync.scene.lights[0]).toBe(light); expect(sync.scene.background).toBe(map);
    expect(light.type === 'EnvironmentLight' && light.map).toBe(map);
    expect((map.image as { data: Float32Array }).data[0]).toBe(Math.fround(0.7));
    expect(sync.update()).toEqual(unchanged);
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
  const sync = new THREESceneSync(source); const [a, b, c, d] = sync.scene.meshes;
  const base = a.materials[0], variant = b.materials[0];
  expect(base).toBe(d.materials[0]); expect(variant).toBe(c.materials[0]); expect(variant).not.toBe(base);
  expect(base.uvProjection).toBe('none'); expect(base.displacementUvProjection).toBe('none');
  expect(variant.uvProjection).toBe('triplanar'); expect(variant.displacementUvProjection).toBe('triplanar');
  expect(a).not.toHaveProperty('uvProjection'); expect(b).not.toHaveProperty('displacementUvProjection');
  expect(sync.update()).toEqual(unchanged);
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
  const sync = new THREESceneSync(source), [a, b] = sync.scene.meshes;
  const cache = (sync as unknown as { _store: { colorVariants: Map<THREE.Material, Map<string, unknown>> } })._store.colorVariants;
  const initial = b.materials[0];
  material.userData.clayptUvProjection = 'spherical'; sync.update();
  expect(a.materials[0].uvProjection).toBe('spherical'); expect(b.materials[0].uvProjection).toBe('spherical');
  expect(b.materials[0].displacementUvProjection).toBe('triplanar'); expect(b.materials[0]).not.toBe(initial);
  expect(cache.get(material)!.size).toBe(1);
  material.userData.clayptDisplacementUvProjection = 'cylindrical'; sync.update();
  expect(b.materials[0]).toBe(a.materials[0]); expect(cache.size).toBe(0);
  material.userData.clayptUvProjection = 'none'; material.userData.clayptDisplacementUvProjection = 'none';
  sync.update(); expect(cache.get(material)!.size).toBe(1);
  material.map = material.displacementMap = null; sync.update();
  expect(b.materials[0]).toBe(a.materials[0]); expect(cache.size).toBe(0);
});


it('retains Three.js matrix precision before CPU inverse transforms', () => {
  const { mesh, sync } = fixture();
  const matrix = sync.scene.meshes[0].matrixWorld;
  mesh.position.set(0.123456789123, 0.234567891234, 0.345678912345);
  mesh.rotation.set(0.123456789123, 0.234567891234, 0.345678912345);
  mesh.scale.set(0.123456789123, 0.234567891234, 0.345678912345);
  sync.update();
  expect(sync.scene.meshes[0].matrixWorld).toBe(matrix);
  expect(Array.from(matrix)).toEqual(mesh.matrixWorld.elements);
  expect(matrix[12]).not.toBe(Math.fround(mesh.matrixWorld.elements[12]));
});
