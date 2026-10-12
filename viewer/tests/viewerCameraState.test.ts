import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCameraState, writeCameraState, type CameraState } from '../src/engine/cameraState';

const state: CameraState = {
  modelId: 'current', position: [2, 3, 4], target: [0, 1, 0], up: [0, 1, 0], near: 0.01, far: 1000, zoom: 1.2, orthoHalfHeight: 1.5,
  settings: { cameraIndex: 2, projection: 'orthographic', fov: 42, fStop: 2.8, focusDistance: 6, metersPerUnit: 0.01, autoRotate: false }
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

  it('reads states saved before the projection setting as perspective', () => {
    const { projection: _, ...settings } = state.settings;
    writeCameraState({ ...state, settings } as CameraState);
    expect(readCameraState('current')?.settings.projection).toBe('perspective');
  });

  it('reads states saved before the f-number lens without depth of field', () => {
    const { fStop: _, metersPerUnit: __, ...settings } = state.settings;
    writeCameraState({ ...state, settings: { ...settings, aperture: 0.02 } } as unknown as CameraState);
    expect(readCameraState('current')?.settings).toEqual({ ...state.settings, fStop: 0, metersPerUnit: null });
  });

  it.each([
    { position: [1, 2] }, { target: [0, null, 0] }, { up: [0, 0, 0] }, { near: -1 }, { far: 0.001 }, { zoom: 0 },
    { settings: { ...state.settings, fov: 180 } }, { settings: { ...state.settings, cameraIndex: -2 } },
    { settings: { ...state.settings, projection: 'fisheye' } }, { orthoHalfHeight: 0 },
    { settings: { ...state.settings, fStop: -1 } }, { settings: { ...state.settings, metersPerUnit: 0 } }
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
