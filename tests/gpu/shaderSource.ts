// Open /tests/gpu/shaderSource.html (?webgl for WebGL 2) on a real GPU.
import type { OpenPBRMaterialParams } from '../../src/scene/OpenPBRMaterial.js';
import { generateVertexTangents } from '../../src/util/geometry.js';
import { Camera, Mesh, OpenPBRMaterial, Engine, Render, SphereLight, Texture, createSphereGeometry } from '../../src/main.js';

export async function capture(layout: Engine['bvhLayout'] = 'bvh2', postProcess = false) {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const engine = new Engine({ canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu' });
  engine.bvhLayout = layout;
  engine.bvhBuilder = layout === 'bvh2' ? 'builtin' : 'tinybvh';
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
  if (postProcess) { engine.display.bloomIntensity = 0.25; render.setDenoiser({type: 'jnlm'}); }
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
// Render each sphere separately so layer/emission changes cannot alter another
// material through indirect lighting. The image is the comparison region.
const materialCases: {name: string; params: OpenPBRMaterialParams}[] = [
  {name: 'coat-darkening-0', params: {coatWeight: 1, coatColor: [0.9, 0.5, 0.2], coatDarkening: 0}},
  {name: 'coat-darkening-1', params: {coatWeight: 1, coatColor: [0.9, 0.5, 0.2], coatDarkening: 1}},
  {name: 'coat-emission', params: {coatWeight: 1, coatColor: [0.9, 0.5, 0.2], emissionColor: [1, 0.7, 0.3], emissionLuminance: 2}},
  {name: 'coat-roughness', params: {coatWeight: 1, specularRoughness: 0.1, coatRoughness: 0.5}},
  {name: 'metal-tint', params: {baseMetalness: 1, specularColor: [0.6, 0.8, 1], specularWeight: 0.5}},
  {name: 'metal-base-weight', params: {baseMetalness: 1, baseWeight: 0.5}},
  {name: 'dielectric-base-weight', params: {baseWeight: 0.3, specularRoughness: 0.2}},
  {name: 'specular-anisotropy', params: {specularAnisotropy: 0.8}},
  {name: 'coat-anisotropy', params: {coatWeight: 1, coatAnisotropy: 0.8}},
  {name: 'fuzz-color', params: {fuzzWeight: 1, fuzzColor: [0.2, 0.4, 1], baseColor: [0.8, 0.2, 0.2]}},
  {name: 'thin-film-coat', params: {thinFilmWeight: 1, thinFilmThickness: 0.4, coatWeight: 1}},
  {name: 'alpha-opaque', params: {alphaMode: 'opaque', opacity: 0.4}},
  {name: 'alpha-mask', params: {alphaMode: 'mask', opacity: 0.7, alphaCutoff: 0.5}}
];

export async function captureMaterials(
  layout: Engine['bvhLayout'] = 'bvh2',
  cases: {name: string; params: OpenPBRMaterialParams}[] = materialCases
) {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const engine = new Engine({canvas, backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  engine.bvhLayout = layout;
  engine.bvhBuilder = layout === 'bvh2' ? 'builtin' : 'tinybvh';
  engine.display.setSize(48, 32);
  const render = new Render(engine, {samplingPattern: 'sobol', bounces: 4});
  try {
    const info = await engine.init();
    const camera = new Camera({projection: 'perspective', aspect: 1.5});
    camera.position = [0, 1, 7]; camera.lookAt([0, 0, 0]);
    const geometry = createSphereGeometry(24, 12);
    generateVertexTangents(geometry);
    const light = new SphereLight({intensity: 50}); light.position = [0, 3, 3];
    const map = new Texture({width: 4, height: 2, data: new Float32Array([
      1, 0.2, 0.1, 1, 0.2, 1, 0.1, 1, 0.1, 0.2, 1, 1, 0.5, 0.5, 0.5, 1,
      0.3, 0.1, 0.1, 1, 0.1, 0.3, 0.1, 1, 0.1, 0.1, 0.3, 1, 0.2, 0.2, 0.2, 1
    ])});
    const backgrounds = [undefined, [0.15, 0.2, 0.3, 1] as [number, number, number, number], map,
      {type: 'GroundedSkybox' as const, map, height: 2, radius: 20, groundHeight: -1}];
    const captures = [];
    for (const {name, params} of cases) {
      const material = new OpenPBRMaterial({baseColor: [0.6, 0.3, 0.15], ...params});
      const mesh = new Mesh(geometry, material);
      for (const [backgroundIndex, background] of backgrounds.entries()) {
        engine.scene = {meshes: [mesh], lights: [light], background}; engine.camera = camera; engine.update();
        await render.converge({samples: 8, sampleSequenceOffset: 17});
        const pixels = await render.readPixels('hdr');
        captures.push({material: name, params, width: pixels.width, height: pixels.height,
          background: backgroundIndex, region: {x: 0, y: 0, width: pixels.width, height: pixels.height},
          data: Array.from(pixels.data)});
      }
    }
    return {backend: engine.backend, adapter: info.adapterName, layout, captures,
      compilation: engine.getDiagnostics()?.shaderCompilation};
  } finally { render.dispose(); engine.dispose(); canvas.remove(); }
}
Object.assign(window, {shaderSourceTests: {capture, captureMaterials}});
