// Fixed-sequence HDR comparison against explicitly scaled source radiance.
import * as THREE from 'three';
import { Engine, Render, THREESync } from '../../src/main.js';

async function run() {
  const webgl = location.search.includes('webgl');
  const engine = new Engine({canvas: document.createElement('canvas'), backend: webgl ? 'webgl' : 'webgpu'});
  engine.display.setSize(16,16);
  const render = new Render(engine);
  const source = new THREE.Scene();
  source.background = new THREE.Color(0,0,0);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8,8), new THREE.MeshStandardMaterial({roughness:1}));
  source.add(mesh, new THREE.AmbientLight(0xffffff,.1));
  const camera = new THREE.OrthographicCamera(-1,1,1,-1,.1,10); camera.position.z=2;
  const sync = new THREESync(engine, {scene:source,camera});
  const pixels = new Float32Array([2,.5,.25,1, .5,1,2,1, 1,.25,.5,1, .25,2,.5,1,
    .2,.3,.4,1, .5,.4,.3,1, .1,.2,.3,1, .4,.2,.1,1]);
  const original = new THREE.DataTexture(pixels,4,2,THREE.RGBAFormat,THREE.FloatType);
  const capture = async () => {
    sync.update(); engine.update();
    await render.converge({samples:32,sampleSequenceOffset:0,timeoutMs:60_000});
    return (await render.readPixels('hdr')).data;
  };
  const results: {name:string;maxError:number}[]=[];
  try {
    for (const intensity of [0,.5,2]) {
      source.environmentIntensity=1;
      const scaled = new THREE.DataTexture(pixels.map((value,index)=>index%4===3?value:value*intensity),4,2,THREE.RGBAFormat,THREE.FloatType);
      source.environment=scaled;
      const expected=await capture();
      source.environment=original; source.environmentIntensity=intensity;
      const actual=await capture();
      const row={name:`environment intensity ${intensity} with ambient`,maxError:Math.max(...actual.map((value,index)=>Math.abs(value-expected[index])))};
      results.push(row); const output=document.createElement('pre');output.textContent=JSON.stringify(row);document.body.append(output);
      scaled.dispose();
    }
    document.querySelector('#summary')!.textContent=JSON.stringify({backend:engine.backend,passed:results.every(r=>Number.isFinite(r.maxError)&&r.maxError<.002)});
  } finally {render.dispose();sync.dispose();engine.dispose();original.dispose();mesh.geometry.dispose();mesh.material.dispose();}
}
run().catch(error=>{document.querySelector('#summary')!.textContent=String(error?.stack??error);});
