/** Internal canvas creation shared by uploads, snapshots, presentation and export. */
export function createCanvas(width = 300, height = 150, offscreen = false): HTMLCanvasElement | OffscreenCanvas {
  if (!offscreen && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  throw new Error('Canvas creation requires document or OffscreenCanvas.');
}
