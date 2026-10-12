import type Camera from '../scene/Camera.js';
/** Freeze camera values without rounding Three.js's double-precision matrices. */
export function cameraSnapshot(source: Camera): Camera {
  const copy = source.clone();
  copy.transform = source.transform.slice();
  return copy;
}
