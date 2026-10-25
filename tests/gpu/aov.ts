import * as THREE from 'three';
import {Engine, Render, THREESync, fromTHREECamera} from '../../src/main.js';
async function captureAovs() {
  const engine = new Engine({canvas: document.createElement('canvas'), backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  const render = new Render(engine, {width: 48, height: 32, bounces: 1});
  const root = new THREE.Scene(), mesh = new THREE.Mesh(new THREE.PlaneGeometry(20,20), new THREE.MeshStandardMaterial({roughness: .4, metalness: .2}));
  root.add(mesh, new THREE.AmbientLight());
  const camera = new THREE.PerspectiveCamera(45, 1.5, .1, 100); camera.position.z = 4; camera.updateMatrixWorld();
  const sync = new THREESync(engine, {scene: root}); sync.update();
  engine.scene = sync.scene; engine.camera = fromTHREECamera(camera); engine.update();
  const errors: string[] = []; engine.on('error', e => errors.push(e.message));
  try {
    const info = await engine.init();
    engine.device?.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    await render.converge({samples: 4}); const before = await render.readPixels('hdr');
    const source = sync.scene.meshes[0]; source.aovId = 101; source.materials[0].aovId = 202; engine.update();
    render.aovs = ['depth', 'position', 'roughness', 'id'];
    await render.converge({samples: 4}); const after = await render.readPixels('hdr');
    const depth = await render.readPixels('depth'), position = await render.readPixels('position'), ids = await render.readPixels('id'), roughness = await render.readPixels('roughness');
    const check = (ok: boolean, message: string) => {if (!ok) throw new Error(message);};
    check(before.data.every((v,i) => Object.is(v, after.data[i])), 'AOV changed beauty');
    check(depth.data.every((v,i) => i%4 !== 0 || Math.abs(v-4) < .001), 'Depth mismatch');
    check(position.data.every((v,i) => i%4 !== 2 || Math.abs(v) < .001), 'Position mismatch');
    check(ids.data.every((v,i) => i%4 === 0 ? v === 101 : i%4 === 2 ? v === 202 : i%4 === 1 ? v === 0 : v < 2), 'ID mismatch');
    check(roughness.data.every((v,i) => i%4 !== 0 || Math.abs(v-.4) < .001), 'Roughness mismatch');
    if (errors.length) throw new Error(errors.join('\n'));
    return {hdr: Array.from(after.data), backend: engine.backend, adapter: info.adapterName, hdrIdentical: true, depth: Array.from(depth.data.slice(0,4)), ids: Array.from(ids.data.slice(0,4)), roughness: Array.from(roughness.data.slice(0,4)), pixels: {id: Array.from(ids.data), depth: Array.from(depth.data), position: Array.from(position.data)}};
  } finally {render.dispose(); engine.dispose(); sync.dispose();}
}
Object.assign(window, {captureAovs});
captureAovs().then(async result => {if (location.search.includes('evidence')) await fetch(`http://localhost:3015/${result.backend}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(result)});Object.assign(window,{aovResult: result}); document.querySelector('#result')!.textContent = JSON.stringify(result);}).catch(e => {document.querySelector('#result')!.textContent = String(e); console.error(e);});
