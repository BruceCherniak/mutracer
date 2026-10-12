import { Camera, Mesh, OpenPBRMaterial, Engine, SphereLight, createSphereGeometry } from '../../src/main.js';
import { measureProgressiveSwitches } from './progressiveRendering.js';

const renderer = new Engine({ canvas: document.getElementById('main') as HTMLCanvasElement,
  backend: new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'auto' });
const camera = new Camera({ projection: 'perspective' });
camera.position = [0, 0, 4]; camera.lookAt([0, 0, 0]);
const light = new SphereLight({ intensity: 30 });
light.position = [2, 3, 2];
const scene = { meshes: [new Mesh(createSphereGeometry(32, 16), new OpenPBRMaterial())],
  lights: [light] };
const button = document.getElementById('run') as HTMLButtonElement;
button.onclick = async () => {
  button.disabled = true;
  try {
    const report = await measureProgressiveSwitches(renderer, scene, camera);
    document.getElementById('result')!.textContent = JSON.stringify(report, null, 2);
  } catch (error) {
    document.getElementById('result')!.textContent = String(error);
  } finally { button.disabled = false; }
};
window.addEventListener('pagehide', () => renderer.dispose());
