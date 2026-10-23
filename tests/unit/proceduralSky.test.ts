import { describe, expect, it } from 'vitest';
import ProceduralSky from '../../src/scene/ProceduralSky';
import Texture from '../../src/scene/Texture';
import EnvironmentLight from '../../src/scene/EnvironmentLight';
import AmbientLight from '../../src/scene/AmbientLight';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import { CommittedScene } from '../../src/renderer/committedScene';
import { SceneEnvironmentCache } from '../../src/renderer/sceneLightChanges';
import { generateBackgroundMapFromSceneBackground } from '../../src/renderer/envMapCreation';

it('creates a texture description without allocating pixels or a graphics context', () => {
  const sky = new ProceduralSky();
  expect(sky).toBeInstanceOf(Texture);
  expect(sky.time).toBe(15);
  expect(sky.resolution).toEqual([2048, 1024]);
  expect(sky.colorSpace).toBe('linear');
  expect('data' in sky.image).toBe(false);
});

it('detects time and resolution edits and commits an isolated sky snapshot', () => {
  const sky = new ProceduralSky({ resolution: [512, 256], time: 9 });
  const scene = { meshes: [], lights: [new EnvironmentLight({ map: sky })], background: sky };
  const detector = new SceneChangeDetector(), committed = new CommittedScene();
  const first = detector.detect(scene);
  const captured = committed.capture(scene, first); detector.commit();
  sky.time = 12;
  expect((captured.lights[0] as EnvironmentLight).map.image).toMatchObject({ time: 9 });
  const time = detector.detect(scene);
  expect(time).toMatchObject({ lights: true, background: true, meshes: 'none' });
  committed.capture(scene, time); detector.commit();
  expect((captured.lights[0] as EnvironmentLight).map.image).toMatchObject({ time: 12 });
  sky.resolution = [256, 128];
  expect(detector.detect(scene)).toMatchObject({ lights: true, background: true }); detector.commit();
  const image = sky.image;
  sky.time = 12; sky.resolution = [256, 128];
  expect(sky.image).toBe(image);
  expect(detector.detect(scene)).toMatchObject({ lights: false, background: false });
});

it('retains generated sources across unrelated edits and preserves intensity, ambient and independent backgrounds', () => {
  const sky = new ProceduralSky({ time: 12 });
  const light = new EnvironmentLight({ map: sky, intensity: 2 });
  const ambient = new AmbientLight({ color: [.1, .2, .3], intensity: .5 });
  const cache = new SceneEnvironmentCache();
  const source = cache.update([light, ambient]);
  expect(source).toMatchObject({ sky: sky.image, width: 2048, height: 1024, intensity: 2, ambient: [.05, .1, .15] });
  expect(source && 'data' in source).toBe(false);
  expect(cache.update([light, ambient])).toBe(source);
  const background = generateBackgroundMapFromSceneBackground(sky);
  expect(background).toMatchObject({ intensity: 1, ambient: [0, 0, 0] });
  sky.time = 9;
  expect(cache.update([light, ambient])).not.toBe(source);
  expect(generateBackgroundMapFromSceneBackground(sky)).not.toBe(background);
});

describe('sky options', () => {
  it.each([NaN, Infinity, -1, 25])('rejects invalid time %s without changing the sky', time => {
    const sky = new ProceduralSky();
    expect(() => new ProceduralSky({ time })).toThrow(RangeError);
    expect(() => { sky.time = time; }).toThrow(RangeError);
    expect(sky.time).toBe(15);
  });
  it.each([[0, 2], [2, -1], [1.5, 2], [NaN, 2], [2, Infinity]])('rejects invalid resolution %s×%s', (width, height) => {
    expect(() => new ProceduralSky({ resolution: [width, height] })).toThrow(RangeError);
  });
  it('allows a full day and independent positive pixel dimensions', () => {
    const sky = new ProceduralSky({ resolution: [1, 7], time: 0 });
    sky.time = 24;
    expect(sky.time).toBe(24);
    expect(sky.resolution).toEqual([1, 7]);
  });
});

it('is exported from the package entry point', async () => {
  expect((await import('../../src/main')).ProceduralSky).toBe(ProceduralSky);
});

it('rejects procedural skies in material texture slots', async () => {
  const { default: MaterialTable } = await import('../../src/renderer/MaterialTable');
  const { default: OpenPBRMaterial } = await import('../../src/scene/OpenPBRMaterial');
  expect(() => new MaterialTable([new OpenPBRMaterial({ map: new ProceduralSky({ resolution: [1, 1] }) })], []))
    .toThrow('environment or background');
});
