import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCameraState, writeCameraState, type CameraState } from '../../viewer/src/engine/cameraState';

const state: CameraState = {
  modelId: 'current', position: [2, 3, 4], target: [0, 1, 0], up: [0, 1, 0], near: 0.01, far: 1000, zoom: 1.2,
  settings: { cameraIndex: 2, fov: 42, aperture: 0.02, focusDistance: 6, autoRotate: false }
};

describe('viewer camera persistence', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('restores orbit and lens state only for the matching model', () => {
    writeCameraState(state);
    expect(readCameraState('current')).toEqual(state);
    expect(readCameraState('other')).toBeNull();
    writeCameraState({ ...state, modelId: 'new' });
    expect(readCameraState('current')).toBeNull();
    expect(readCameraState('new')?.settings.cameraIndex).toBe(2);
  });

  it.each([
    { position: [1, 2] }, { target: [0, null, 0] }, { up: [0, 0, 0] }, { near: -1 }, { far: 0.001 }, { zoom: 0 },
    { settings: { ...state.settings, fov: 180 } }, { settings: { ...state.settings, cameraIndex: -2 } }
  ])('ignores invalid camera data: %j', (patch) => {
    writeCameraState({ ...state, ...patch } as CameraState);
    expect(readCameraState('current')).toBeNull();
  });

  it('does not interrupt interaction if browser preferences are unavailable', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Full'); } });
    expect(() => writeCameraState(state)).not.toThrow();
    expect(readCameraState('current')).toBeNull();
  });
});
