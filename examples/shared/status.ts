import {
  type Renderer,
  type RenderStatus
} from '@meimu/mutracer';

const labels: Record<RenderStatus, string> = {
  ['preparing']: 'Preparing scene',
  ['compiling']: 'Compiling shaders',
  ['converging']: 'Converging',
  ['denoising']: 'Denoising',
  ['finished']: 'Finished',
  ['error']: 'Error (see console)'
};

/** Writes the render status and sample count into `element`. */
export function showStatus(
  element: HTMLElement,
  renderer: Renderer,
  status: RenderStatus
) {
  const samples = renderer.samples;
  const backend = renderer.backend === 'webgpu' ? 'WebGPU' : renderer.backend === 'webgl' ? 'WebGL 2' : 'Initializing';
  element.textContent =
    `${labels[status] ?? ''} · ${samples} / ${renderer.maxSamples} spp · ${backend}`;
}
