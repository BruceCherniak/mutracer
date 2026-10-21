import { describe, expect, it } from 'vitest';
import RectLight from '../../src/scene/RectLight';
import MaterialTable from '../../src/renderer/MaterialTable';
import { RectLightTextureTracker } from '../../src/renderer/sceneLightChanges';
import { packLightsToBuffer } from '../../src/renderer/lightsUtil';
import { packAnalyticsLightsToBuffer } from '../../src/renderer/WGPURayTracePass';

describe.each([
  { backend: 'WebGL', pack: packLightsToBuffer },
  { backend: 'WebGPU', pack: packAnalyticsLightsToBuffer }
])('$backend light texture indices', ({ pack }) => {
  it.each([0, 1])('packs a newly added untextured light after %i existing lights', (initialCount) => {
    const lights = Array.from({ length: initialCount }, () => new RectLight());
    const tracker = new RectLightTextureTracker();
    tracker.update(lights);
    const materialTable = new MaterialTable([], lights);

    lights.push(new RectLight());
    expect(tracker.update(lights)).toBe(false);

    const pmfs = lights.map(() => 1 / lights.length);
    const packed = pack(lights, materialTable.getLightTexturesIndices(), pmfs);
    const freshTable = new MaterialTable([], lights);
    const freshPacked = pack(lights, freshTable.getLightTexturesIndices(), pmfs);

    expect(packed.every(Number.isFinite)).toBe(true);
    expect(packed[initialCount * 24 + 15]).toBe(-1);
    expect(packed).toEqual(freshPacked);
  });

  it('preserves zero, positive and absent texture indices', () => {
    const indices = [0, 3, -1];
    const lights = indices.map(() => new RectLight());
    const packed = pack(lights, indices, lights.map(() => 1 / lights.length));

    expect(indices.map((_, i) => packed[i * 24 + 15])).toEqual(indices);
  });
});
