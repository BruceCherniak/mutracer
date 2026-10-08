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
      console.log('Is Intel Mac');
    }
  } catch (e) {}
}

export { isIntelMac };
