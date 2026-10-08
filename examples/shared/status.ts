import {
  RENDER_STATUS_COMPILING_SHADER,
  RENDER_STATUS_DENOISING,
  RENDER_STATUS_ERROR,
  RENDER_STATUS_FINISHED,
  RENDER_STATUS_PREPARING,
  RENDER_STATUS_RENDERING,
  type Renderer,
  type RenderStatus
} from 'claypt';

const labels: Record<number, string> = {
  [RENDER_STATUS_PREPARING]: 'Preparing scene',
  [RENDER_STATUS_COMPILING_SHADER]: 'Compiling shaders',
  [RENDER_STATUS_RENDERING]: 'Rendering',
  [RENDER_STATUS_DENOISING]: 'Denoising',
  [RENDER_STATUS_FINISHED]: 'Finished',
  [RENDER_STATUS_ERROR]: 'Error (see console)'
};

/** Writes the render status and sample count into `element`. */
export function showStatus(
  element: HTMLElement,
  renderer: Renderer,
  status: RenderStatus
) {
  const samples = renderer.getTotalSamplesRendered() ?? 0;
  const backend = renderer.isUsingWebGPU() ? 'WebGPU' : 'WebGL 2';
  element.textContent =
    `${labels[status] ?? ''} · ${samples} / ${renderer.maxSamples} spp · ${backend}`;
}
