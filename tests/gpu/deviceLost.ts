import {Engine, Render, RenderLoop, getRecommendedDeviceDescriptor} from '../../src/main.js';
import {setBasicScene} from './hostScene.js';
const query = new URLSearchParams(location.search);
const supplied = query.has('device');
const adapter = supplied ? await navigator.gpu.requestAdapter() : null;
const device = adapter ? await adapter.requestDevice(getRecommendedDeviceDescriptor(adapter)) : undefined;
const engine = new Engine({canvas: document.getElementById('main') as HTMLCanvasElement, device,
  backend: query.has('webgl') ? 'webgl' : 'webgpu'});
setBasicScene(engine);
(window as any).captureDeviceLoss = async () => {
  const events: unknown[] = []; engine.on('devicelost', value => events.push(value));
  const render = new Render(engine, {maxSamples: 64, bounces: 6, denoiser: {type: 'jnlm'}});
  await render.converge({samples: 64, sampleSequenceOffset: 0});
  const before = await render.readPixels('hdr'); const initialDevice = engine.device;
  const lost = new Promise<void>(resolve => engine.on('devicelost', () => resolve()));
  let convergenceError: string | undefined;
  if (engine.device) {
    let destroyed = false;
    try {await render.converge({samples: 1024, samplesPerBatch: 1, onProgress: progress => {
      if (!destroyed && progress.samples > 0) {destroyed = true; engine.device!.destroy();}
    }});}
    catch (error) {convergenceError = String(error);}
    if (!convergenceError?.includes('device lost')) throw new Error('Active convergence did not reject on device loss');
  }
  else {
    const gl = (engine.display.canvas as HTMLCanvasElement).getContext('webgl2')!;
    const extension = gl.getExtension('WEBGL_lose_context')!;
    extension.loseContext(); await lost; setTimeout(() => extension.restoreContext(), 50);
  }
  await lost;
  const lossStatus = render.status, lossSamples = render.samples, lossError = engine.lastError?.message;
  if (supplied) {
    const replacementAdapter = await navigator.gpu.requestAdapter();
    if (!replacementAdapter) throw new Error('Replacement adapter unavailable');
    await engine.setDevice(await replacementAdapter.requestDevice(getRecommendedDeviceDescriptor(replacementAdapter)));
  }
  const loop = new RenderLoop(engine, {preview: false, final: render});
  const statuses: string[] = [];
  for (let attempts = 0; attempts < 3000 && loop.status !== 'finished'; attempts++) {
    statuses.push(loop.tick()); if (loop.status === 'error') throw engine.lastError;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  if (loop.status !== 'finished') throw new Error('Device recovery timed out');
  await render.converge({samples: 64, sampleSequenceOffset: 0});
  const after = await render.readPixels('hdr');engine.display.present(render);
  const output = {before: Array.from(before.data), after: Array.from(after.data), events, lossStatus, lossSamples, lossError,
    convergenceError, statuses: [...new Set(statuses)], replacedDevice: initialDevice !== engine.device, info: engine.info, diagnostics: engine.getDiagnostics()};
  document.getElementById('result')!.textContent = JSON.stringify({...output, before: undefined, after: undefined}, null, 2);
  loop.dispose();render.dispose();return output;
};
window.addEventListener('pagehide', () => engine.dispose());
