import type Engine from '../../src/Engine.js';
import Render from '../../src/Render.js';
import type Camera from '../../src/scene/Camera.js';
import type {Scene} from '../../src/scene/Scene.js';

/** Real-GPU allocation/fallback probe using only first-layer image operations. */
export async function measureProgressiveSwitches(engine: Engine, scene: Scene, camera: Camera) {
  engine.display.setSize(1024, 1024); engine.scene = scene; engine.camera = camera; engine.update(); await engine.init();
  const preview = new Render(engine, {resolutionScale: .5, maxSamples: 1, bounces: 2, bevel: false, dispersionWavelengths: 1, directLightCandidates: 2});
  const final = new Render(engine, {maxSamples: 2, timeBudgetMs: 1, maxTiles: 1, fallback: preview});
  const frames: {preview: boolean; samples: number; presentedTarget?: string; presentedComplete?: boolean}[] = [];
  async function complete(render: Render) {
    for (let attempts = 0; attempts < 2000; attempts++) {
      const status = render.refine(); const shown = engine.display.present(render); const diagnostics = engine.getDiagnostics();
      frames.push({preview: shown === preview, samples: render.samples, presentedTarget: diagnostics?.presentedTarget, presentedComplete: diagnostics?.presentedComplete});
      if (status === 'error') throw engine.lastError;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (render.samples >= 1) return;
    }
    throw new Error('Progressive switch did not complete.');
  }
  async function cycle() {preview.restart(); final.restart(); await complete(preview); await complete(final);}
  await cycle(); await cycle();
  const allocations = {textures: 0, buffers: 0, framebuffers: 0}; const restores: (() => void)[] = [];
  function count<T extends object, K extends keyof T>(owner: T, key: K, counter: keyof typeof allocations) {
    const original = owner[key], callable = original as (...args: unknown[]) => unknown;
    owner[key] = function(this: T, ...args: unknown[]) {allocations[counter]++; return callable.apply(this, args);} as T[K];
    restores.push(() => {owner[key] = original;});
  }
  if (engine.device) {count(engine.device, 'createTexture', 'textures'); count(engine.device, 'createBuffer', 'buffers');}
  else {const gl = engine.display.canvas.getContext('webgl2')!; count(gl, 'createTexture', 'textures'); count(gl, 'createFramebuffer', 'framebuffers');}
  frames.length = 0;
  try {
    for (let i = 0; i < 10; i++) await cycle();
    await engine.device?.queue.onSubmittedWorkDone();
    return {backend: engine.backend, allocations, frames, diagnostics: engine.getDiagnostics()};
  } finally {restores.forEach(restore => restore()); preview.dispose(); final.dispose();}
}
