import {Camera, Engine, Mesh, OpenPBRMaterial, Render, RenderLoop, SphereLight, Sync, createSphereGeometry} from '../../src/main.js';

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** Fixed-scene throughput, pixel equivalence and idle-to-drag latency probe. */
export async function measureRealtimeSampling(backend: 'webgpu' | 'webgl' = 'webgpu', width = 1280, height = 800, samples = 256) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const engine = new Engine({canvas, backend}); engine.display.setSize(width, height);
  const camera = new Camera({projection: 'perspective'});
  camera.position = [0, 0, 4]; camera.lookAt([0, 0, 0]); engine.camera = camera;
  const light = new SphereLight({intensity: 30}); light.position = [2, 3, 2];
  engine.scene = {meshes: [new Mesh(createSphereGeometry(32, 16), new OpenPBRMaterial({baseColor: [.6, .3, .15]}))], lights: [light]};
  class Interaction extends Sync { moving = false; update() {} get active() {return this.moving;} }
  const sync = new Interaction(engine);
  const loop = new RenderLoop(engine, {sync, preview: {maxSamples: 1}, final: {maxSamples: samples, batchSamples: true}});
  const errors: string[] = [];
  try {
    await engine.init();
    engine.device?.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    const waitGpu = () => {
      if (engine.device) return engine.device.queue.onSubmittedWorkDone();
      // Synchronize GPU completion for WebGL latency measurements as well.
      (canvas.getContext('webgl2') as WebGL2RenderingContext).finish();
      return Promise.resolve();
    };
    const tick = () => {if (loop.tick() === 'error') throw engine.lastError;};
    async function finish() {
      for (let i = 0; i < 4000; i++) {tick(); if (loop.status === 'finished') {await waitGpu(); return;} await frame();}
      throw new Error('Realtime sampling did not finish');
    }
    // Compile both targets before measuring, including the interactive shaders.
    sync.moving = true;
    for (let i = 0; i < 12; i++) {await frame(); tick();}
    sync.moving = false; await finish();
    const runs: {samplesPerSecond: number; milliseconds: number; maxSamplesPerTick: number; ticks: number}[] = [];
    for (let run = 0; run < 3; run++) {
      loop.final.restart(); await frame(); const start = performance.now();
      let maxSamplesPerTick = 0, ticks = 0;
      for (; ticks < 4000; ticks++) {
        const before = loop.final.samples; tick();
        maxSamplesPerTick = Math.max(maxSamplesPerTick, loop.final.samples - before);
        if (loop.status === 'finished') break;
        await frame();
      }
      if (ticks === 4000) throw new Error('Throughput probe timed out');
      await waitGpu(); const milliseconds = performance.now() - start;
      runs.push({samplesPerSecond: samples * 1000 / milliseconds, milliseconds, maxSamplesPerTick, ticks: ticks + 1});
    }
    const actual = await loop.final.readPixels('hdr');
    const hdrSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', actual.data.buffer as ArrayBuffer)), byte => byte.toString(16).padStart(2, '0')).join('');
    const control = new Render(engine, {maxSamples: samples, batchSamples: false});
    let maxAbsoluteError = 0, offlineSamplesPerSecond = 0;
    try {
      const start = performance.now(); await control.converge({samples});
      offlineSamplesPerSecond = samples * 1000 / (performance.now() - start);
      const expected = await control.readPixels('hdr');
      if (actual.data.length !== expected.data.length) throw new Error('Pixel dimensions differ');
      for (let i = 0; i < actual.data.length; i++) {
        if (!Number.isFinite(actual.data[i]) || !Number.isFinite(expected.data[i])) throw new Error(`Nonfinite HDR component ${i}`);
        maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(actual.data[i] - expected.data[i]));
      }
    } finally {control.dispose();}

    const firstPreviewMs: number[] = [], movingPreviewMs: number[] = [], tickMs: number[] = [];
    loop.final.maxSamples = 100000;
    for (let cycle = 0; cycle < 12; cycle++) {
      sync.moving = false; camera.position = [0, 0, 4]; engine.update();
      for (let i = 0; i < 10; i++) {await frame(); tick();}
      // Start input between display ticks, when final's GPU queue may be full.
      await new Promise(resolve => setTimeout(resolve, cycle % 4));
      sync.moving = true; camera.position = [.1 + cycle * .01, 0, 4];
      const start = performance.now(); tick(); tickMs.push(performance.now() - start);
      await waitGpu(); firstPreviewMs.push(performance.now() - start);
      for (let i = 0; i < 6; i++) {
        await frame(); camera.position = [.1 + cycle * .01 + i * .01, 0, 4];
        const start = performance.now(); tick(); tickMs.push(performance.now() - start);
        await waitGpu(); movingPreviewMs.push(performance.now() - start);
      }
    }
    const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
    const summary = (values: number[]) => ({median: percentile(values, .5), p95: percentile(values, .95), max: Math.max(...values)});
    if (maxAbsoluteError !== 0 || errors.length) throw new Error(JSON.stringify({maxAbsoluteError, errors}));
    return {backend: engine.backend, width, height, samples, batching: loop.final.batchSamples,
      runs, offlineSamplesPerSecond, maxAbsoluteError, hdrSha256, firstPreviewMs: summary(firstPreviewMs), movingPreviewMs: summary(movingPreviewMs), tickMs: summary(tickMs),
      diagnostics: engine.getDiagnostics(), errors};
  } finally {loop.dispose(); sync.dispose(); engine.dispose(); canvas.remove();}
}
