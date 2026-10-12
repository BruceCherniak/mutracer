// Open /tests/gpu/shaderSource.html (?webgl for WebGL 2) on a real GPU.
import { Camera, Mesh, OpenPBRMaterial, Engine, Render, SphereLight, Texture, createSphereGeometry } from '../../src/main.js';

export async function capture(layout: Engine['bvhLayout'] = 'bvh2', postProcess = false) {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const engine = new Engine({ canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu' });
  engine.bvhLayout = layout;
  engine.display.setSize(48, 32);
  const info = await engine.init();
  const camera = new Camera({ projection: 'perspective', aspect: 1.5 });
  camera.position = [0, 1, 7]; camera.lookAt([0, 0, 0]);
  const weights = [{thinFilmWeight: 1, thinFilmThickness: 400}, {coatWeight: 1}, {fuzzWeight: 1}, {subsurfaceWeight: 0.7}];
  const geometry = createSphereGeometry(24, 12);
  const meshes = weights.map((weight, i) => {
    const mesh = new Mesh(geometry, new OpenPBRMaterial({...weight, baseColor: [0.6, 0.3, 0.15]}));
    mesh.position = [(i - 1.5) * 1.2, 0, 0];
    return mesh;
  });
  const light = new SphereLight({ intensity: 50 }); light.position = [0, 3, 3];
  const map = new Texture({ width: 4, height: 2, data: new Float32Array([
    1, 0.2, 0.1, 1, 0.2, 1, 0.1, 1, 0.1, 0.2, 1, 1, 0.5, 0.5, 0.5, 1,
    0.3, 0.1, 0.1, 1, 0.1, 0.3, 0.1, 1, 0.1, 0.1, 0.3, 1, 0.2, 0.2, 0.2, 1
  ]) });
  const backgrounds = [undefined, [0.15, 0.2, 0.3, 1] as [number, number, number, number], map,
    {type: 'GroundedSkybox' as const, map, height: 2, radius: 20, groundHeight: -1}];
  const render = new Render(engine, {samplingPattern: 'sobol', bounces: 4});
  if (postProcess) { engine.display.bloomIntensity = 0.25; render.denoiser = {type: 'jnlm'}; }
  const captures = [];
  try {
    for (const [width, height] of (postProcess ? [[48, 32], [30, 20], [48, 32]] : [[48, 32]])) {
      engine.display.setSize(width, height);
      for (const background of backgrounds) {
        engine.scene = {meshes, lights: [light], background}; engine.camera = camera; engine.update();
        await render.converge({samples: 8, sampleSequenceOffset: 17});
        const pixels = await render.readPixels('hdr');
        const denoised = postProcess ? await render.readPixels('denoised') : undefined;
        const depth = await engine.readDepthSamples({x: 0.5, y: 0.5, size: 0.3});
        captures.push({width: pixels.width, height: pixels.height, background: captures.length % 4, data: Array.from(pixels.data),
          denoised: denoised && Array.from(denoised.data), depth: depth && Array.from(depth)});
      }
    }
    return {backend: engine.backend, adapter: info.adapterName, layout, captures, compilation: engine.getDiagnostics()?.shaderCompilation};
  } finally { render.dispose(); engine.dispose(); canvas.remove(); }
}
Object.assign(window, {shaderSourceTests: {capture}});
