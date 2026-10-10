import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Camera from '../../src/scene/Camera';
import makeWGPURenderingPipeline from '../../src/renderer/WGPURenderingPipeline';
import type { OIDNWeb } from '../../src/renderer/WGPURenderingPipeline';

// Keep the real pipeline and tile scheduler; replace GPU execution at the pass boundary.
const mocks = vi.hoisted(() => {
  class Pass {
    static instances = new Map<string, Pass>();
    texture = { width: 80, height: 64, format: 'rgba8unorm' };
    constructor(label = '') { Pass.instances.set(label, this); }
    setSize(width: number, height: number) {
      this.texture = { ...this.texture, width, height };
    }
    setUniform = vi.fn();
    setOutputParams() {}
    setRenderToScreen = vi.fn();
    getOutput() { return this.texture; }
    createPass = vi.fn();
    dispose() {}
  }
  class TracePass extends Pass {
    static latest: TracePass;
    constructor() { super(); TracePass.latest = this; }
    setSampleSequenceOffset = vi.fn();
    setSampleCount = vi.fn();
    setCamera() {}
    cameraChanged() { return false; }
    setJitter() {}
    setSampleTiles() {}
    setPreviewMode() {}
    updatePipeline() {}
    isCompilingShader() { return false; }
    isPipelineReady() { return true; }
    hasShadowCatcher() { return false; }
    needsDenoiseAlpha() { return false; }
    getOutputBuffer() { return {}; }
    setBounce() { return true; }
    setClamping() { return true; }
    setDirectLightCandidates() { return true; }
    setAlphaBlendStrategy() { return true; }
    setBevelSamples() { return true; }
    setSamplingPattern = vi.fn(() => true);
  }
  class OutputPass extends Pass {
    setSampleCount() {}
    setSampleTileGrid() {}
  }
  return { Pass, TracePass, OutputPass };
});
vi.mock('../../src/renderer/WGPURayTracePass', () => ({ default: mocks.TracePass }));
vi.mock('../../src/renderer/WGPURayTraceOutput', () => ({ WGPURayTraceOutputPass: mocks.OutputPass }));
vi.mock('../../src/renderer/WGPUFullQuadPass', () => ({ WGPUFullQuadPass: mocks.Pass }));
vi.mock('../../src/renderer/WGPUComputePass', () => ({ WGPUComputePass: mocks.Pass }));
vi.mock('../../src/renderer/WGPUAutoExposure', () => ({ default: mocks.Pass }));

function createPipeline(timestamps = true, traceTimeNs: bigint | (() => bigint) = 1_000_000n) {
  const device = {
    features: new Set(timestamps ? ['timestamp-query'] : []),
    createQuerySet: () => ({ count: 2, destroy() {} }),
    createBuffer: () => ({
      size: 16, mapState: 'unmapped', destroy() {}, unmap() {},
      mapAsync: async () => {},
      getMappedRange: () => new BigInt64Array([
        0n, typeof traceTimeNs === 'function' ? traceTimeNs() : traceTimeNs
      ]).buffer
    }),
    createTexture: (opts: GPUTextureDescriptor) => ({
      ...opts.size, format: opts.format, destroy: vi.fn()
    }),
    createSampler: () => ({}),
    createCommandEncoder: () => ({
      resolveQuerySet() {}, copyBufferToBuffer() {}, copyBufferToTexture() {},
      copyTextureToTexture() {}, finish() { return {}; }
    }),
    queue: { submit() {}, onSubmittedWorkDone: async () => {} }
  } as unknown as GPUDevice;
  const canvas = {
    getContext: () => ({ configure() {}, getCurrentTexture() { return {}; } })
  } as unknown as HTMLCanvasElement;
  const pipeline = makeWGPURenderingPipeline(canvas, device);
  pipeline.setSize(80, 64);
  return pipeline;
}

beforeEach(() => {
  vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
  vi.stubGlobal('GPUBufferUsage', { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 });
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 1, COPY_DST: 2, COPY_SRC: 4 });
  vi.stubGlobal('GPUMapMode', { READ: 1 });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('Image', class {
    src = '';
    set onload(callback: () => void) { callback(); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('WebGPU offline sampling', () => {
  it.each([true, false])('submits only samples 0..7 after offline settings change (timestamps=%s)', async (timestamps) => {
    const pipeline = createPipeline(timestamps);
    pipeline.setOfflineRenderOptions({ samplesPerBatch: 4, deferPostProcess: true, sampleSequenceOffset: 0 });
    pipeline.restartSamples();
    // Renderer applies these after configuring the offline batch on its first render.
    pipeline.setBouncesAndClamping(6, 0);
    pipeline.setDirectLightCandidates(2);
    pipeline.setAlphaBlendStrategy('stochastic');
    pipeline.setBevelSamples(2);
    pipeline.draw(new Camera('perspective'), 8);
    expect(pipeline.getTotalSamplesRendered()).toBe(4);
    pipeline.draw(new Camera('perspective'), 8);
    expect(pipeline.getTotalSamplesRendered()).toBe(8);
    expect(mocks.TracePass.latest.setSampleCount.mock.calls.map(([sample]) => sample)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await pipeline.flushDiagnostics();
    pipeline.dispose();
  });

  it('keeps the realtime timing probe and re-enables it after returning from offline mode', async () => {
    const pipeline = createPipeline();
    pipeline.setOfflineRenderOptions({ samplesPerBatch: 4, deferPostProcess: true, sampleSequenceOffset: 0 });
    pipeline.setBouncesAndClamping(6, 0);
    pipeline.draw(new Camera('perspective'), 8);
    expect(pipeline.getTotalSamplesRendered()).toBe(4);
    await pipeline.flushDiagnostics();
    pipeline.setOfflineRenderOptions({ samplesPerBatch: 0, deferPostProcess: false, sampleSequenceOffset: 0 });
    pipeline.setBouncesAndClamping(3, 0);
    mocks.TracePass.latest.setSampleCount.mockClear();
    pipeline.draw(new Camera('perspective'), 8);
    expect(pipeline.getTotalSamplesRendered()).toBe(0);
    await pipeline.flushDiagnostics();
    pipeline.draw(new Camera('perspective'), 8);
    expect(pipeline.getTotalSamplesRendered()).toBe(1);
    expect(mocks.TracePass.latest.setSampleCount.mock.calls.map(([sample]) => sample)).toEqual([0, 0]);
    await pipeline.flushDiagnostics();
    pipeline.dispose();
  });

  it('does not re-enable a probe when offline rendering exits interactive preview', async () => {
    const pipeline = createPipeline();
    const camera = new Camera('perspective');
    pipeline.needsRestartSample(camera, true);
    expect(pipeline.isPreviewMode()).toBe(true);
    pipeline.setOfflineRenderOptions({ samplesPerBatch: 4, deferPostProcess: true, sampleSequenceOffset: 0 });
    pipeline.setInteractivePreviewParams({
      enabled: false, resolutionScale: 0.5, bounces: 2, idleDelayMs: 150
    });
    expect(pipeline.isPreviewMode()).toBe(false);
    pipeline.draw(camera, 8);
    pipeline.draw(camera, 8);
    expect(pipeline.getTotalSamplesRendered()).toBe(8);
    expect(mocks.TracePass.latest.setSampleCount.mock.calls.map(([sample]) => sample)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await pipeline.flushDiagnostics();
    pipeline.dispose();
  });
});

it('restarts accumulation after changing the sampling pattern', () => {
  const pipeline = createPipeline(false);
  const camera = new Camera('perspective', 45, 1, 0.1, 100);
  pipeline.setOfflineRenderOptions({samplesPerBatch:4,deferPostProcess:true,sampleSequenceOffset:0});
  pipeline.draw(camera,4);
  expect(pipeline.getTotalSamplesRendered()).toBe(4);
  const trace=mocks.TracePass.latest;
  trace.setSampleCount.mockClear();
  expect(pipeline.setSamplingPattern('zsobol',4)).toBe(true);
  pipeline.draw(camera,4);
  expect(trace.setSampleCount.mock.calls.map(([value])=>value)).toEqual([0,1,2,3]);
});

function completedDenoiser(): OIDNWeb {
  return {
    tileExecute(opts) {
      const image = {
        data: { size: opts.color.width * opts.color.height * 16 } as GPUBuffer,
        width: opts.color.width, height: opts.color.height
      };
      opts.progress?.(image, undefined,
        { x: 0, y: 0, width: image.width, height: image.height }, 0, 1);
      opts.done(image);
      return () => {};
    }
  };
}

function displayedTexture() {
  return mocks.Pass.instances.get('output')!.createPass.mock.lastCall![1].colorTex;
}

async function denoisedPipeline() {
  const pipeline = createPipeline(false);
  pipeline.setOIDNPreviewActive(true);
  pipeline.draw(new Camera('perspective'), 1);
  await pipeline.performOIDNDenoise(completedDenoiser(), undefined, true);
  return pipeline;
}

describe('WebGPU denoised presentation transitions', () => {
  it('immediately restores a resized canvas from the completed presentation', async () => {
    const pipeline = await denoisedPipeline();
    const completedTexture = displayedTexture();
    pipeline.setSize(160, 96);
    const snapshot = displayedTexture();
    expect(snapshot).not.toBe(completedTexture);
    expect(snapshot).toMatchObject({ width: 80, height: 64 });
    expect(mocks.Pass.instances.get('output')!.setRenderToScreen).toHaveBeenCalled();
    pipeline.drawPostProcess();
    expect(displayedTexture()).toBe(snapshot);
    pipeline.dispose();
  });

  it('cancels an in-flight denoise on resize without losing the completed image', async () => {
    const pipeline = await denoisedPipeline();
    const abort = vi.fn();
    let options: Parameters<OIDNWeb['tileExecute']>[0];
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = pipeline.performOIDNDenoise({
      tileExecute(opts) {
        options = opts;
        started();
        return abort;
      }
    }, undefined, true);
    await ready;
    pipeline.setSize(160, 96);
    const snapshot = displayedTexture();
    expect(snapshot).toMatchObject({ width: 80, height: 64 });
    expect(abort).toHaveBeenCalledOnce();
    expect(await pending).toBe(false);
    options!.progress?.({ data: {} as GPUBuffer, width: 80, height: 64 },
      undefined, { x: 0, y: 0, width: 80, height: 64 }, 0, 1);
    expect(displayedTexture()).toBe(snapshot);
    pipeline.dispose();
  });

  it('re-presents the completed frame when camera preview starts, then settles', async () => {
    const pipeline = await denoisedPipeline();
    const camera = new Camera('perspective');
    pipeline.needsRestartSample(camera, true);
    expect(pipeline.isPreviewMode()).toBe(true);
    pipeline.draw(camera, 1);
    const snapshot = displayedTexture();
    expect(snapshot).toMatchObject({ width: 80, height: 64 });
    // Composition is updated with raw samples while the snapshot is held.
    // Settling must keep the displayed snapshot, not capture those raw samples.
    pipeline.setPreviewTransitionDenoisePending(true);
    pipeline.setInteractivePreviewParams({
      enabled: false, resolutionScale: 0.5, bounces: 2, idleDelayMs: 150
    });
    pipeline.draw(camera, 1);
    expect(displayedTexture()).toBe(snapshot);
    await pipeline.performOIDNDenoise(completedDenoiser(), undefined, true);
    expect(displayedTexture()).not.toBe(snapshot);
    pipeline.dispose();
  });

  it('holds the completed preview after OIDN lowers its adaptive resolution', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const pipeline = createPipeline(false);
      pipeline.setSize(320, 256);
      pipeline.setOIDNPreviewActive(true);
      const camera = new Camera('perspective');
      pipeline.needsRestartSample(camera, true);
      pipeline.draw(camera, 1);
      const denoiser = completedDenoiser();
      const execute = denoiser.tileExecute;
      denoiser.tileExecute = (opts) => {
        now += 640;
        return execute(opts);
      };
      expect(await pipeline.performOIDNDenoise(denoiser, undefined, true)).toBe(true);
      expect(pipeline.isFirstFrame()).toBe(true);
      expect(pipeline.getTotalSamplesRendered()).toBe(0);
      pipeline.drawPostProcess();
      const snapshot = displayedTexture();
      expect(snapshot).toMatchObject({ width: 160, height: 128 });
      pipeline.draw(camera, 1);
      expect(displayedTexture()).toBe(snapshot);
      await pipeline.performOIDNDenoise(completedDenoiser(), undefined, true);
      expect(displayedTexture()).toMatchObject({ width: 48, height: 32 });
      pipeline.dispose();
    } finally {
      clock.mockRestore();
    }
  });

  it('invalidates completed samples when asynchronous GPU timing resizes a Toy Car-sized preview', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      let readbacks = 0;
      const pipeline = createPipeline(true, () =>
        ++readbacks === 1 ? 20_000_000n : 400_000_000n);
      pipeline.setSize(2496, 1594);
      pipeline.setOIDNPreviewActive(true);
      pipeline.setInteractivePreviewParams({
        enabled: true, resolutionScale: 1, bounces: 2, idleDelayMs: 150
      });
      const camera = new Camera('perspective');
      pipeline.needsRestartSample(camera, true);
      pipeline.draw(camera, 1);
      await pipeline.flushDiagnostics();
      pipeline.draw(camera, 1);
      expect(pipeline.getTotalSamplesRendered()).toBe(1);
      await pipeline.flushDiagnostics();
      expect(pipeline.isFirstFrame()).toBe(true);
      expect(pipeline.getTotalSamplesRendered()).toBe(0);
      const denoiser = completedDenoiser();
      const execute = vi.spyOn(denoiser, 'tileExecute');
      expect(await pipeline.performOIDNDenoise(denoiser, undefined, true)).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      // Even after the idle deadline, finish a sample at the new preview
      // resolution before returning to the full-resolution denoise.
      now = 200;
      expect(pipeline.needsRestartSample(camera)).toBe(false);
      expect(pipeline.isPreviewMode()).toBe(true);
      pipeline.draw(camera, 1);
      expect(pipeline.getTotalSamplesRendered()).toBe(1);
      expect(await pipeline.performOIDNDenoise(denoiser, undefined, true)).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      pipeline.dispose();
    } finally {
      clock.mockRestore();
    }
  });

  it('stops holding the previous denoise when denoising is disabled or samples restart', async () => {
    const pipeline = await denoisedPipeline();
    pipeline.setSize(160, 96);
    const snapshot = displayedTexture();
    pipeline.restartSamples();
    pipeline.draw(new Camera('perspective'), 1);
    expect(displayedTexture()).not.toBe(snapshot);
    await pipeline.performOIDNDenoise(completedDenoiser(), undefined, true);
    pipeline.setSize(240, 128);
    const nextSnapshot = displayedTexture();
    pipeline.setOIDNPreviewActive(false);
    pipeline.draw(new Camera('perspective'), 1);
    expect(displayedTexture()).not.toBe(nextSnapshot);
    pipeline.dispose();
  });
});


it('falls back to AgX for unknown tone mapping values', () => {
  const pipeline = createPipeline(false);
  pipeline.setToneMappingParams({ toneMapping: 'aces' });
  const compose = mocks.Pass.instances.get('compose')!;
  compose.setUniform.mockClear();
  pipeline.setToneMappingParams({ toneMapping: 'removed-mode' as never });
  expect(compose.setUniform).toHaveBeenCalledWith('toneMappingParams', [0, 0]);
  pipeline.dispose();
});
