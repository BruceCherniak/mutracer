import type { Engine, Render } from '@meimu/mutracer';

/** Temporary application selection policy; R3 replaces it with RenderLoop. */
export function exampleSelection(engine: Engine, preview: Render, final: Render) {
  let initialized = false, lastChange = -Infinity;
  return (changed: boolean) => {
    const now = performance.now();
    if (changed && initialized) lastChange = now;
    initialized = true;
    // Preserve the existing WebGL native-resolution exception through R1.
    const nativeWebGL = engine.backend === 'webgl' && engine.display.canvas.width * engine.display.canvas.height <= 1_000_000;
    preview.resolutionScale = nativeWebGL ? 1 : .5;
    preview.adaptiveResolution = nativeWebGL ? false : {targetFrameMs: 20, minScale: .25};
    return now - lastChange < 150 ? preview : final;
  };
}
