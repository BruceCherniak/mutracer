import type { BufferGeometry } from 'three';

/** Slider guidance only: the material value remains a length in local units. */
export function displacementHeightRange(geometry?: BufferGeometry) {
  if (geometry?.getAttribute('position') && !geometry.boundingBox) geometry.computeBoundingBox();
  const bounds = geometry?.boundingBox;
  const size = bounds ? Math.max(
    bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z
  ) : 0;
  const max = Number.isFinite(size) && size > 0 ? size * .1 : 1;
  const step = Number(`1e${Math.floor(Math.log10(max)) - 3}`);
  return { min: 0, max, step };
}
