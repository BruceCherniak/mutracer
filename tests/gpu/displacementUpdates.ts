// Run npm run dev and open /tests/gpu/displacementUpdates.html on a real GPU.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Engine, Render, THREESync, Texture } from '../../src/main.js';

const parameters = new URLSearchParams(location.search);
const webgl = parameters.has('webgl');
const builder = parameters.get('builder') === 'tinybvh' ? 'tinybvh' : 'builtin';
const captures: { label: string; data: Float32Array }[] = [];

async function fixture() {
  const source = new THREE.Scene();
  source.add(new THREE.Mesh(new THREE.SphereGeometry(.65, 24, 12), new THREE.MeshBasicMaterial({ color: 0xff8040 })));
  const glb = await new GLTFExporter().parseAsync(source, { binary: true }) as ArrayBuffer;
  const root = (await new GLTFLoader().parseAsync(glb, '')).scene;
  const scene = new THREE.Scene(); scene.add(root);
  const canvas = document.createElement('canvas');
  const engine = new Engine({ canvas, backend: webgl ? 'webgl' : 'webgpu' });
  engine.display.setSize(64, 64);
  engine.bvhBuilder = builder;
  const camera = new THREE.PerspectiveCamera(40, 1, .1, 10);
  camera.position.set(0, 0, 3); camera.lookAt(0, 0, 0);
  const sync = new THREESync(engine, { scene, camera }); sync.update();
  const material = sync.scene!.meshes[0].materials[0];
  const render = new Render(engine, { width: 64, height: 64, bounces: 2, samplingPattern: 'sobol' });
  const info = await engine.init();
  return { canvas, engine, sync, render, material, info };
}

function heightTexture(inverse = false) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
  const context = canvas.getContext('2d')!;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const value = ((x + y) % 2 === 0) !== inverse ? 64 : 192;
    context.fillStyle = `rgb(${value},${value},${value})`; context.fillRect(x, y, 1, 1);
  }
  return new Texture(canvas);
}

async function capture(f: Awaited<ReturnType<typeof fixture>>, label: string) {
  f.sync.update(); f.engine.update();
  await f.render.converge({ samples: 16, sampleSequenceOffset: 17 });
  const pixels = (await f.render.readPixels('hdr')).data.slice() as Float32Array;
  captures.push({ label, data: pixels });
  // Render to an ordinary image for side-by-side visual inspection.
  const figure = document.createElement('figure'), caption = document.createElement('figcaption');
  const image = new Image(); image.width = image.height = 192;
  image.src = URL.createObjectURL(await f.engine.display.toBlob(f.render));
  caption.textContent = label; figure.append(image, caption); document.getElementById('captures')!.append(figure);
  return pixels;
}

function difference(a: Float32Array, b: Float32Array) {
  let sum = 0, changed = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i]); sum += delta; if (delta > 1e-5) changed++;
  }
  return { meanAbsolute: sum / a.length, changedValues: changed };
}

async function run() {
  const f = await fixture();
  let reference: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const baseline = await capture(f, 'No height map');
    f.material.displacementMap = heightTexture(); f.material.displacementScale = .2;
    const added = await capture(f, 'Added, height 0.2');
    f.material.displacementScale = .4;
    const scaled = await capture(f, 'Height 0.4');
    f.material.displacementMap = heightTexture(true);
    const replaced = await capture(f, 'Replaced height map');
    f.material.displacementMap = undefined;
    const removed = await capture(f, 'Removed height map');
    reference = await fixture();
    reference.material.displacementMap = heightTexture(); reference.material.displacementScale = .4;
    const fresh = await capture(reference, 'Fresh height 0.4');
    const comparisons = {
      added: difference(baseline, added), scaled: difference(added, scaled), replaced: difference(scaled, replaced),
      removed: difference(baseline, removed), fresh: difference(scaled, fresh)
    };
    const passed = Object.values(comparisons).every((value) => Number.isFinite(value.meanAbsolute)) &&
      (webgl ? comparisons.added.changedValues === 0 && comparisons.scaled.changedValues === 0 :
        comparisons.added.changedValues > 100 && comparisons.scaled.changedValues > 100 && comparisons.replaced.changedValues > 100) &&
      comparisons.removed.changedValues === 0 && comparisons.fresh.changedValues === 0;
    document.getElementById('result')!.textContent = JSON.stringify({ passed, backend: f.engine.backend, builder,
      adapter: f.info.adapterName, comparisons }, null, 2);
    const download = document.createElement('a'); download.textContent = 'Download HDR evidence';
    download.download = `displacement-${f.engine.backend}-${builder}.json`;
    download.href = URL.createObjectURL(new Blob([JSON.stringify(captures.map(({label, data}) => ({label, data: Array.from(data)})))]));
    document.body.append(download);
  } finally {
    for (const item of [f, reference]) { item?.render.dispose(); item?.sync.dispose(); item?.engine.dispose(); }
  }
}
void run().catch(error => { document.getElementById('result')!.textContent = `FAILED: ${error.stack ?? error}`; });
