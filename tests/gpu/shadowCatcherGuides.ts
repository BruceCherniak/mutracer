// Open this fixture on a real GPU, with ?webgl for WebGL 2.
import {
  Camera, Engine, Mesh, OpenPBRMaterial, Render, createPlaneGeometry
} from '../../src/main.js';

/** Check receiver features without changing the invisible ground's radiance or coverage. */
export async function capture() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  const render = new Render(engine, {width: 32, height: 32, bounces: 2, bevel: false});
  const plane = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({shadowCatcher: true, baseColor: [.1, .2, .3]}));
  // Rotate the receiver so a hardcoded +Y normal cannot pass this check.
  plane.transform[0] = .8; plane.transform[1] = -.6;
  plane.transform[4] = .6; plane.transform[5] = .8;
  const camera = new Camera({projection: 'orthographic', left: -.5, right: .5, bottom: -.5, top: .5});
  camera.position = [2.4, 3.2, 0]; camera.lookAt([0, 0, 0], [0, 0, 1]);
  engine.camera = camera;
  const frames = [];
  try {
    const info = await engine.init();
    for (const alpha of [0, 1]) {
      engine.scene = {meshes: [plane], lights: [], background: [.2, .3, .4, alpha]}; engine.update();
      await render.converge({samples: 2, sampleSequenceOffset: 17});
      const albedo = await render.readPixels('albedo');
      const normal = await render.readPixels('normal');
      const hdr = await render.readPixels('hdr');
      for (let i = 0; i < hdr.data.length; i += 4) {
        const expectedNormal = [.8, .9, .5, 1];
        for (let channel = 0; channel < 4; channel++) {
          if (Math.abs(normal.data[i + channel] - expectedNormal[channel]) > .005) {
            throw new Error(`Receiver normal mismatch at ${i / 4}, channel ${channel}`);
          }
          if (channel < 3 && Math.abs(albedo.data[i + channel] - 1) > .005) {
            throw new Error(`Receiver albedo mismatch at ${i / 4}, channel ${channel}`);
          }
          const expected = channel === 3 ? alpha : alpha * [.2, .3, .4][channel];
          if (Math.abs(hdr.data[i + channel] - expected) > .005) {
            throw new Error(`Invisible receiver changed HDR at ${i / 4}, channel ${channel}`);
          }
        }
      }
      frames.push({alpha, pixels: hdr.data.length / 4});
    }
    return {backend: engine.backend, adapter: info.adapterName, frames};
  } finally { render.dispose(); engine.dispose(); canvas.remove(); }
}
Object.assign(window, {shadowCatcherGuides: {capture}});
