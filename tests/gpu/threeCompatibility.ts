// Compare fixed-sequence HDR pixels to Three.js on a real GPU; add ?webgl for WebGL 2.
import * as THREE from 'three';
import { Engine, Render, THREESync } from '../../src/main.js';

async function run() {
  const webgl = location.search.includes('webgl');
  const reference = new THREE.WebGLRenderer();
  reference.outputColorSpace = THREE.LinearSRGBColorSpace;
  const target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.FloatType, depthBuffer: false });
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10); camera.position.z = 2;
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry(8, 8);
  const material = new THREE.MeshBasicMaterial({ toneMapped: false });
  scene.add(new THREE.Mesh(geometry, material));
  const results: { name: string; maxError?: number; error?: string; expected?: number[]; actual?: number[]; lengths?: number[] }[] = [];
  const capture = async (name: string, texture: THREE.DataTexture) => {
    texture.needsUpdate = true; material.map = texture;
    reference.setRenderTarget(target); reference.render(scene, camera);
    const expected = new Float32Array(1024); reference.readRenderTargetPixels(target, 0, 0, 16, 16, expected);
    const engine = new Engine({canvas: document.createElement('canvas'), backend: webgl ? 'webgl' : 'webgpu'});
    engine.display.setSize(16, 16);
    const render = new Render(engine), sync = new THREESync(engine, {scene, camera});
    try {
      sync.update(); engine.update();
      await render.converge({samples: 4, sampleSequenceOffset: 0, timeoutMs: 60_000});
      const actual = (await render.readPixels('hdr')).data;
      const maxError = Math.max(...actual.map((value, i) => Math.abs(value - expected[i])));
      results.push({name, maxError, expected: [...expected.slice(0,4)], actual: [...actual.slice(0,4)], lengths: [expected.length, actual.length]});
    } catch (error) { results.push({name, error: String(error)}); }
    finally { render.dispose(); sync.dispose(); engine.dispose(); texture.dispose(); }
    const row = document.createElement('pre'); row.textContent = JSON.stringify(results.at(-1)); document.body.append(row);
  };
  try {
    await capture('half-float RGBA', new THREE.DataTexture(new Uint16Array([0x4000, 0x3800, 0x3400, 0x3c00]), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType));
    await capture('RedFormat', new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat));
    await capture('RGFormat', new THREE.DataTexture(new Uint8Array([255, 255]), 1, 1, THREE.RGFormat));
    document.querySelector('#summary')!.textContent = JSON.stringify({backend: webgl ? 'webgl' : 'webgpu',
      passed: results.every(r => r.maxError !== undefined && Number.isFinite(r.maxError) && r.maxError < .002)});
  } finally { reference.dispose(); target.dispose(); geometry.dispose(); material.dispose(); }
}
run().catch(error => { document.querySelector('#summary')!.textContent = String(error?.stack ?? error); });
