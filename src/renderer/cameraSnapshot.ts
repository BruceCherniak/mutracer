import type Camera from '../scene/Camera.js';
/** Freeze camera values without rounding Three.js's double-precision matrices. */
export function cameraSnapshot(source: Camera): Camera {
  const copy = source.clone();
  const transform = source.transform;
  // scriptc needs concrete array arms for slice(); preserve number[] precision.
  copy.transform = transform instanceof Float32Array ? transform.slice() : transform.slice();
  return copy;
}
