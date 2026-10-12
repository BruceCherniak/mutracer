import type Camera from '../scene/Camera.js';

/** Internal perspective lens focal length in millimetres, including zoom. */
export function cameraFocalLength(camera: Camera): number {
  if (camera.projection !== 'perspective') return 0;
  return 0.5 * camera.sensorHeight * Math.max(camera.zoom, Number.EPSILON) /
    Math.tan(camera.fov * Math.PI / 360);
}

/** Internal aperture radius in scene units; invalid or disabled lenses return zero. */
export function cameraApertureRadius(camera: Camera): number {
  if (!(camera.fStop > 0) || !(camera.metersPerUnit > 0)) return 0;
  const radius = cameraFocalLength(camera) / (2 * camera.fStop) / 1000 / camera.metersPerUnit;
  return Number.isFinite(radius) && radius > 0 ? radius : 0;
}
