import type Renderer from '../../src/Renderer.js';
import type Camera from '../../src/scene/Camera.js';
import type { Scene } from '../../src/scene/Scene.js';
import type { RenderingPipeline } from '../../src/renderer/RenderingPipeline.js';

/** Browser-side GPU acceptance probe; CPU performance belongs in Node benchmarks. */
export async function measureProgressiveSwitches(renderer: Renderer, scene: Scene, camera: Camera) {
  await renderer.init();
  await renderer.setDenoiser(false);
  const pipeline = (renderer as unknown as { _pipeline: RenderingPipeline })._pipeline;
  renderer.setSize(1024, 1024);
  renderer.previewMaxResolutionScale = 0.5;
  renderer.previewTargetFrameMs = 100_000; // Keep dimensions fixed during allocation counting.
  renderer.previewIdleDelayMs = 0;
  renderer.maxTimePerTile = 1;
  renderer.maxSamples = 2;
  renderer.previewEnabled = true;
  renderer.render(scene, camera);

  const frames: { preview: boolean; samples: number; presentedTarget?: string; presentedComplete?: boolean }[] = [];
  async function complete(preview: boolean) {
    let attempts = 0;
    do {
      renderer.render(scene, camera);
      const diagnostics = renderer.getDiagnostics();
      frames.push({ preview: pipeline.isPreviewMode(), samples: pipeline.getTotalSamplesRendered(),
        presentedTarget: diagnostics?.presentedTarget, presentedComplete: diagnostics?.presentedComplete });
      if (renderer.status === 'error') throw renderer.lastError;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (++attempts > 2000) throw new Error('Progressive switch did not complete.');
    } while (pipeline.isPreviewMode() !== preview || pipeline.isFirstFrame() || pipeline.getTotalSamplesRendered() < 1);
  }
  async function cycle() {
    pipeline.needsRestartSample(camera, true);
    await complete(true);
    await complete(false);
  }
  await cycle();
  await cycle(); // Warm both targets and their timing/compilation paths.
  const allocations = { textures: 0, buffers: 0, framebuffers: 0 };
  const restores: (() => void)[] = [];
  function count<T extends object, K extends keyof T>(owner: T, key: K, counter: keyof typeof allocations) {
    const original = owner[key];
    const callable = original as (...args: unknown[]) => unknown;
    owner[key] = function(this: T, ...args: unknown[]) {
      allocations[counter]++;
      return callable.apply(this, args);
    } as T[K];
    restores.push(() => { owner[key] = original; });
  }
  if (renderer.device) {
    count(renderer.device, 'createTexture', 'textures');
    count(renderer.device, 'createBuffer', 'buffers');
  } else {
    const gl = renderer.canvas.getContext('webgl2')!;
    count(gl, 'createTexture', 'textures');
    count(gl, 'createFramebuffer', 'framebuffers');
  }
  frames.length = 0;
  try {
    for (let i = 0; i < 10; i++) await cycle();
    await pipeline.flushDiagnostics();
    return { backend: renderer.backend, allocations, frames, diagnostics: renderer.getDiagnostics() };
  } finally {
    restores.forEach(restore => restore());
  }
}
