import {Engine, Render} from '../../src/main.js';
import {setBasicScene} from './hostScene.js';

// Verify the browser release with the public Render API. Native resident-buffer
// normalization, scheduling and retention are tested by the Rust host suite.
async function captureOIDNRelease() {
  const engine = new Engine({canvas: document.createElement('canvas'), backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  const render = new Render(engine, {width: 128, height: 96, maxSamples: 4, bounces: 3});
  const errors: string[] = [];
  engine.on('error', error => errors.push(error.message));
  try {
    setBasicScene(engine);
    const info = await engine.init();
    engine.device?.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    await render.converge({samples: 4, sampleSequenceOffset: 17});
    const raw = await render.readPixels('hdr');
    const models = [];
    for (const model of ['small', 'standard', 'cleanAuxLarge'] as const) {
      // Local weights make this test independent of CDN availability.
      await render.setDenoiser({type: 'oidn', model, weightsBaseUrl: '/oidn/weights/'});
      await render.converge({samples: 4, sampleSequenceOffset: 17});
      const unchanged = await render.readPixels('hdr');
      if (!unchanged.data.every((value, index) => value === raw.data[index])) throw new Error(`${model}: denoising changed accumulation`);
      if (engine.backend === 'webgpu') {
        const output = await render.readPixels('denoised');
        if (!output.data.every(Number.isFinite)) throw new Error(`${model}: nonfinite output`);
        if (output.data.every((value, index) => value === raw.data[index])) throw new Error(`${model}: no filtering`);
      }
      models.push(model);
    }
    if (errors.length) throw new Error(errors.join('\n'));
    const result = {backend: engine.backend, adapter: info.adapterName, models, finite: true, rawHDRUnchanged: true};
    document.querySelector('#result')!.textContent = JSON.stringify(result, null, 2);
    return {...result, hdr: Array.from(raw.data)};
  } finally {render.dispose(); engine.dispose();}
}
Object.assign(window, {captureOIDNRelease});
