import { expect, it } from 'vitest';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import { MaterialChangeTracker } from '../../src/renderer/materialChanges';
const texture = () => new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
it('classifies parameters, emission, textures and geometry with the heaviest level winning', () => {
  const m = new OpenPBRMaterial(); const tracker = new MaterialChangeTracker();
  tracker.capture([m]); m.baseColor[0] = 0.4; m.markUpdated();
  expect(tracker.classify([m])).toEqual({ level: 'params', emission: false });
  tracker.capture([m]); m.emissionLuminance = 5;
  expect(tracker.classify([m])).toEqual({ level: 'emission', emission: true });
  tracker.capture([m]); m.map = texture();
  expect(tracker.classify([m])).toEqual({ level: 'textures', emission: false });
  tracker.capture([m]); m.map.uvScale[0] = 2;
  expect(tracker.classify([m]).level).toBe('textures');
  tracker.capture([m]); m.map.markUpdated();
  expect(tracker.classify([m]).level).toBe('textures');
  tracker.capture([m]); m.displacementScale++;
  expect(tracker.classify([m]).level).toBe('geometry');
});
it('treats tessellated emission and displacement texture edits as geometry changes', () => {
  const m = new OpenPBRMaterial(); m.displacementMode = 'tessellated'; m.displacementMap = texture();
  const tracker = new MaterialChangeTracker(); tracker.capture([m]); m.emissionColor[0] = 0.5;
  expect(tracker.classify([m]).level).toBe('geometry');
  tracker.capture([m]); m.displacementMap.markUpdated();
  expect(tracker.classify([m]).level).toBe('geometry');
});
