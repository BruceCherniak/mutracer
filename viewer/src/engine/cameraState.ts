import type { Settings } from '../store';

export type CameraSettings = Pick<Settings, 'cameraIndex' | 'fov' | 'aperture' | 'focusDistance' | 'autoRotate'>;
export interface CameraState {
  modelId: string;
  position: number[];
  target: number[];
  up: number[];
  near: number;
  far: number;
  zoom: number;
  settings: CameraSettings;
}

const KEY = 'mutracer-viewer:camera:v1';

export function cameraSettings(settings: Settings): CameraSettings {
  const { cameraIndex, fov, aperture, focusDistance, autoRotate } = settings;
  return { cameraIndex, fov, aperture, focusDistance, autoRotate };
}

export function readCameraState(modelId: string): CameraState | null {
  try {
    const state = JSON.parse(localStorage.getItem(KEY) || 'null') as CameraState | null;
    if (!state || state.modelId !== modelId) return null;
    const vector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
    if (![state.position, state.target, state.up].every(vector)) return null;
    if (![state.near, state.far, state.zoom].every(Number.isFinite) || state.near <= 0 || state.far <= state.near || state.zoom <= 0) return null;
    const s = state.settings;
    if (!s || !Number.isInteger(s.cameraIndex) || s.cameraIndex < -1 || !Number.isFinite(s.fov) || s.fov <= 0 || s.fov >= 180 ||
      !Number.isFinite(s.aperture) || s.aperture < 0 || !Number.isFinite(s.focusDistance) || s.focusDistance <= 0 || typeof s.autoRotate !== 'boolean') return null;
    if (state.up.every((n) => n === 0) || state.position.every((n, i) => n === state.target[i])) return null;
    return state;
  } catch {
    return null;
  }
}

export function writeCameraState(state: CameraState) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* Optional preferences. */ }
}
