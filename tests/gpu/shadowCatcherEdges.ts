// Open on a real GPU; ?webgl checks the fallback backend.
import {Camera, Engine, Mesh, OpenPBRMaterial, Render, createCubeGeometry, createPlaneGeometry} from '../../src/main.js';
import {checkShadowCatcherLayers} from './shadowCatcherLayers.js';

async function capture() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  const render = new Render(engine, {width: 96, height: 80, bounces: 2, bevel: false});
  const plane = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({shadowCatcher: true}));
  const cube = new Mesh(createCubeGeometry(), new OpenPBRMaterial({unlit: true, baseColor: [.18, .3, .6]}));
  cube.transform[0] = cube.transform[5] = cube.transform[10] = .35;
  cube.transform[13] = .36;
  const camera = new Camera({projection: 'orthographic', left: -1.6, right: 1.6, bottom: -1.3, top: 1.3});
  camera.position = [2.1, 3.2, 4]; camera.lookAt([0, 0, 0]);
  engine.camera = camera; engine.display.setSize(96, 80);
  const evidence: unknown[] = [], results = [];
  try {
    const info = await engine.init();
    const cases: {name: string; background: number[]; exposure?: number; object?: boolean; bloom?: number; hdr?: boolean; denoise?: boolean}[] = [
      {name: 'white', background: [1, 1, 1, 1]},
      {name: 'receiver without model', background: [1, 1, 1, 1]},
      {name: 'colored', background: [.18, .4, .7, 1]},
      {name: 'exposure', background: [1, 1, 1, 1], exposure: 2},
      {name: 'transparent', background: [0, 0, 0, 0]},
      {name: 'white object', background: [1, 1, 1, 1], object: true},
      {name: 'colored object', background: [.18, .4, .7, 1], object: true},
      {name: 'bloom', background: [1, 1, 1, 1], object: true, bloom: .2},
      ...(engine.backend === 'webgpu' ? [
        {name: 'HDR', background: [1, 1, 1, 1], hdr: true},
        {name: 'OIDN', background: [1, 1, 1, 1], denoise: true}
      ] : [])
    ];
    for (const entry of cases) {
      Object.assign(engine.display, {toneMappingExposure: entry.exposure ?? 1, bloomIntensity: entry.bloom ?? 0, hdrOutputEnabled: entry.hdr ?? false});
      await render.setDenoiser(entry.denoise ? {type: 'oidn', model: 'standard', weightsBaseUrl: '/oidn/weights/'} : null);
      const images: number[][] = [], hdrImages: number[][] = [];
      for (const catcher of [false, true]) {
        cube.transform[12] = entry.object ? 0 : 20;
        engine.scene = {meshes: [...(entry.name === 'receiver without model' ? [] : [cube]), ...(catcher ? [plane] : [])], lights: [], background: entry.background as [number, number, number, number]};
        engine.update();
        await render.converge({samples: 32, sampleSequenceOffset: 17});
        hdrImages.push(Array.from((await render.readPixels('hdr')).data));
        const blob = await engine.display.toBlob(render);
        const bitmap = await createImageBitmap(blob), image = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = image.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
        images.push(Array.from(context.getImageData(0, 0, image.width, image.height).data));
        if (entry.name === 'white' && catcher) {
          const preview = document.createElement('img'); preview.src = URL.createObjectURL(blob); document.body.append(preview);
        }
      }
      // There is no occluder or lighting: the invisible plane must not add an edge.
      let maxDisplayDelta = 0, changedPixels = 0, maxHdrDelta = 0;
      for (let i = 0; i < images[0].length; i += 4) {
        const x = (i / 4) % 96, y = Math.floor(i / 4 / 96);
        // Compare the receiver edge, away from the model silhouette and bloom.
        // OIDN's padding at the image border is unrelated to catcher coverage.
        if (entry.object && Math.abs(x - 48) < 20 && Math.abs(y - 40) < 20) continue;
        if (entry.denoise && (x < 8 || x >= 88 || y < 8 || y >= 72)) continue;
        let delta = 0;
        for (let ch = 0; ch < 4; ch++) {
          delta = Math.max(delta, Math.abs(images[0][i + ch] - images[1][i + ch]));
          maxHdrDelta = Math.max(maxHdrDelta, Math.abs(hdrImages[0][i + ch] - hdrImages[1][i + ch]));
        }
        maxDisplayDelta = Math.max(maxDisplayDelta, delta);
        if (delta > (entry.denoise ? 8 : 1)) changedPixels++;
      }
      // Raw HDR retains native hit-count normalization; compare it separately
      // from the composed display, whose invisible receiver must be seamless.
      results.push({name: entry.name, maxDisplayDelta, changedPixels, maxHdrDelta, pass: changedPixels === 0});
      evidence.push({name: entry.name, images, hdrImages});
    }
    const layers = engine.device ? await checkShadowCatcherLayers(engine.device) : undefined;
    return {backend: engine.backend, adapter: info.adapterName, results, layers, evidence};
  } finally { render.dispose(); engine.dispose(); }
}
const result = document.querySelector('#result')!;
capture().then(value => {
  const {evidence, ...summary} = value;
  result.textContent = JSON.stringify({...summary, pass: summary.results.every(result => result.pass)}, null, 2);
  const button = document.querySelector<HTMLButtonElement>('#download')!;
  button.disabled = false;
  button.onclick = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(value)], {type: 'application/json'}));
    a.download = `shadow-catcher-edges-${value.backend}.json`; a.click();
  };
}, error => {result.textContent = `${error}\n${error.stack ?? ""}`;});
