// Open on a real GPU; ?webgl checks the fallback backend. Emission from a
// mesh must not change the catcher: a black-textured or bright emissive sphere
// leaves the floor as it is with the same sphere unlit.
import {Camera, Engine, EnvironmentLight, Mesh, OpenPBRMaterial, ProceduralSky, Render, Texture,
  createCubeGeometry, createPlaneGeometry, createSphereGeometry} from '../../src/main.js';

const WIDTH = 160, HEIGHT = 96, SAMPLES = 64;

async function displayPixels(engine: Engine, render: Render) {
  const blob = await engine.display.toBlob(render);
  const bitmap = await createImageBitmap(blob), image = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = image.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
  const preview = document.createElement('img'); preview.src = URL.createObjectURL(blob); document.body.append(preview);
  return context.getImageData(0, 0, image.width, image.height).data;
}

function luminance(pixels: Uint8ClampedArray, i: number) {
  return .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
}

async function capture() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  const render = new Render(engine, {width: WIDTH, height: HEIGHT, bounces: 2, bevel: false});
  const plane = new Mesh(createPlaneGeometry(), new OpenPBRMaterial({shadowCatcher: true}));
  plane.transform[0] = plane.transform[10] = 4;
  const cube = new Mesh(createCubeGeometry(), new OpenPBRMaterial({baseColor: [.6, .6, .6]}));
  cube.transform[0] = cube.transform[5] = cube.transform[10] = .3;
  cube.transform[12] = -.7; cube.transform[13] = .3;
  const sphereMaterial = new OpenPBRMaterial({baseColor: [.6, .6, .6]});
  const sphere = new Mesh(createSphereGeometry(), sphereMaterial);
  sphere.transform[0] = sphere.transform[5] = sphere.transform[10] = .35;
  sphere.transform[12] = .7; sphere.transform[13] = .35;
  const camera = new Camera({projection: 'perspective', fov: 40});
  camera.position = [0, 2.2, 3.6]; camera.lookAt([0, .2, 0]);
  const sky = new ProceduralSky({resolution: [512, 256], time: 15});
  engine.camera = camera; engine.display.setSize(WIDTH, HEIGHT);
  const black = new Texture({width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255])});
  const variants: {name: string; luminance: number; map?: Texture; offset?: number}[] = [
    {name: 'unlit sphere', luminance: 0},
    {name: 'unlit sphere, other sequence', luminance: 0, offset: 1000},
    {name: 'black-textured emissive sphere', luminance: 2000, map: black},
    {name: 'bright emissive sphere', luminance: 20}
  ];
  try {
    const info = await engine.init();
    const lights = [new EnvironmentLight({map: sky})];
    // Object mask: everything the camera sees without the catcher.
    engine.scene = {meshes: [cube, sphere], lights, background: [1, 1, 1, 1]};
    engine.update();
    await render.converge({samples: 4, sampleSequenceOffset: 0});
    const objects = await displayPixels(engine, render);
    // Backends tone map the backdrop differently; the top-left corner is sky.
    const backdrop = objects[0];
    const floor: number[] = [];
    for (let i = 0; i < objects.length; i += 4) {
      const x = (i / 4) % WIDTH, y = Math.floor(i / 4 / WIDTH);
      let object = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = Math.min(WIDTH - 1, Math.max(0, x + dx)), ny = Math.min(HEIGHT - 1, Math.max(0, y + dy));
        const j = (ny * WIDTH + nx) * 4;
        if ([0, 1, 2].some(ch => Math.abs(objects[j + ch] - backdrop) > 1)) object = true;
      }
      if (!object) floor.push(i);
    }
    const images: Uint8ClampedArray[] = [];
    for (const variant of variants) {
      Object.assign(sphereMaterial, {emissionColor: [1, 1, 1], emissionLuminance: variant.luminance, emissiveMap: variant.map});
      engine.scene = {meshes: [plane, cube, sphere], lights, background: [1, 1, 1, 1]};
      engine.update();
      await render.converge({samples: SAMPLES, sampleSequenceOffset: variant.offset ?? 0});
      images.push(await displayPixels(engine, render));
    }
    const reference = images[0];
    const results = variants.map((variant, index) => {
      let sum = 0, darker = 0, lighter = 0, max = 0, mean = 0;
      for (const i of floor) {
        const delta = luminance(images[index], i) - luminance(reference, i);
        sum += Math.abs(delta); max = Math.max(max, Math.abs(delta)); mean += luminance(images[index], i);
        if (delta < -2) darker++; else if (delta > 2) lighter++;
      }
      return {name: variant.name, meanFloorLuminance: +(mean / floor.length).toFixed(2), meanAbsDelta: +(sum / floor.length).toFixed(3),
        maxDelta: +max.toFixed(1), darkerPercent: +(100 * darker / floor.length).toFixed(2), lighterPercent: +(100 * lighter / floor.length).toFixed(2)};
    });
    // Emission must stay within the sequence noise of the unlit reference.
    const noise = results[1].meanAbsDelta;
    const pass = results.slice(2).every(result => result.meanAbsDelta <= Math.max(noise * 1.5, .05));
    return {backend: engine.backend, adapter: info.adapterName, floorPixels: floor.length, results, pass};
  } finally { render.dispose(); engine.dispose(); }
}
const result = document.querySelector('#result')!;
capture().then(value => { result.textContent = JSON.stringify(value, null, 2); },
  error => { result.textContent = `${error}\n${error.stack ?? ''}`; });
