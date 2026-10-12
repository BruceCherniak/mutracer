import type { Engine, Render } from '@meimu/mutracer';
const labels: Record<Render['status'] | 'previewing', string> = {
  preparing: 'Preparing scene', compiling: 'Compiling shaders', previewing: 'Previewing',
  converging: 'Converging', denoising: 'Denoising', finished: 'Finished', error: 'Error (see console)'
};
/** Application status; only the final render contributes formal samples. */
export function showStatus(element: HTMLElement, engine: Engine, final: Render, status: Render['status'] | 'previewing') {
  const backend = engine.backend === 'webgpu' ? 'WebGPU' : engine.backend === 'webgl' ? 'WebGL 2' : 'Initializing';
  element.textContent = `${labels[status]} · ${final.samples} / ${final.maxSamples} spp · ${backend}`;
}
