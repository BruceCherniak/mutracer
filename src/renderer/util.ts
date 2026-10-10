import { WritableArrayLike } from '../types';

export function clamp(x: number, min: number, max: number) {
  return Math.min(Math.max(x, min), max);
}

export function shuffle(arr: WritableArrayLike<number>, rand: () => number) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const x = arr[i];
    arr[i] = arr[j];
    arr[j] = x;
  }
  return arr;
}

export function numberArraysEqual(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  eps = 1e-4
) {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > eps) {
      return false;
    }
  }

  return true;
}
export const isMac =
  typeof navigator !== 'undefined' && navigator.userAgent.match('Macintosh');

let isIntelMac = false;
if (isMac) {
  try {
    const ctx = document.createElement('canvas').getContext('webgl');
    const d = ctx && ctx.getExtension('WEBGL_debug_renderer_info');
    const g = (d && ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) || '';
    if (!(g.match(/Apple M/) || g.match(/Apple GPU/))) {
      isIntelMac = true;
    }
  } catch (e) {}
}

export { isIntelMac };

/** Lowest resolution scale interactive preview adapts down to. */
export const MIN_PREVIEW_SCALE = 0.25;

/**
 * Next interactive-preview resolution scale from a preview frame time measured
 * at `measuredScale`. Tracing and denoising cost grow with the pixel count
 * (scale²), so the scale follows the square root of the time ratio. Steps are
 * 1/16 (1/32 below 0.25); a change of less than 15% from `currentScale` keeps
 * it, because every resolution change restarts sampling.
 */
export function nextPreviewScale(
  measuredScale: number,
  frameTimeMs: number,
  targetTimeMs: number,
  maxScale: number,
  currentScale = measuredScale,
  minScale = MIN_PREVIEW_SCALE
) {
  const raw = measuredScale * Math.sqrt(targetTimeMs / Math.max(frameTimeMs, 0.1));
  const steps = raw < 0.25 ? 32 : 16;
  const next = clamp(Math.round(raw * steps) / steps, minScale, Math.max(minScale, maxScale));
  return Math.abs(Math.log(next / currentScale)) >= Math.log(1.15) ? next : currentScale;
}
