// Minimal MuTracer scene: procedural geometry, OpenPBR materials, an area light
// and an HDR environment. Drag to orbit, scroll to zoom.
import { mat4 } from 'gl-matrix';
import {
  Camera,
  CameraViewControl,
  EnvironmentLight,
  Mesh,
  OpenPBRMaterial,
  RectLight,
  Renderer,
  type Scene,
  createCubeGeometry,
  createPlaneGeometry,
  createSphereGeometry
} from '@meimu/mutracer';
import { createSkyTexture } from './shared/sky';
import { showStatus } from './shared/status';

const canvas = document.getElementById('main') as HTMLCanvasElement;
const statusElement = document.getElementById('status')!;

function material(props: Partial<OpenPBRMaterial>) {
  return Object.assign(new OpenPBRMaterial(), props);
}

// Floor: the plane is 2x2 in XZ, so scale it up.
const floor = new Mesh(
  createPlaneGeometry(),
  material({ baseColor: [0.55, 0.55, 0.55], specularRoughness: 0.6 })
);
mat4.fromScaling(floor.matrixWorld, [6, 1, 6]);

// Unit spheres placed with a translation and scale.
const sphere = createSphereGeometry(64, 32);
function addSphere(x: number, props: Partial<OpenPBRMaterial>) {
  const mesh = new Mesh(sphere, material(props));
  mat4.fromTranslation(mesh.matrixWorld, [x, 0.5, 0]);
  mat4.scale(mesh.matrixWorld, mesh.matrixWorld, [0.5, 0.5, 0.5]);
  return mesh;
}
const spheres = [
  addSphere(-1.2, { baseColor: [0.8, 0.15, 0.1], specularRoughness: 0.4 }),
  addSphere(0, { baseColor: [0.95, 0.75, 0.35], baseMetalness: 1, specularRoughness: 0.2 }),
  addSphere(1.2, { transmissionWeight: 1, specularRoughness: 0 })
];

const cube = new Mesh(createCubeGeometry(), material({ baseColor: [0.2, 0.4, 0.8] }));
mat4.fromTranslation(cube.matrixWorld, [-0.6, 0.3, -1.3]);
mat4.scale(cube.matrixWorld, cube.matrixWorld, [0.3, 0.3, 0.3]);

// A rect light emits towards its local -Z; rotate it to face down.
const light = new RectLight([1.5, 1.5], [1, 0.9, 0.8], 6);
mat4.fromTranslation(light.matrixWorld, [-1.5, 3, 1.5]);
mat4.rotateX(light.matrixWorld, light.matrixWorld, -Math.PI / 2);

const scene: Scene = {
  meshes: [floor, ...spheres, cube],
  lights: [light, new EnvironmentLight(createSkyTexture())]
};

const camera = new Camera('perspective', 40, 1, 0.1, 100);
Camera.lookAt(camera, [0, 2.4, 6], [0, 0.3, -0.3]);
const controls = new CameraViewControl({ camera, domElement: canvas });

// Uses WebGPU when available and WebGL 2 otherwise; add ?webgl to the URL to
// force the WebGL 2 backend.
const renderer = new Renderer({
  canvas,
  preferWebGPU: !new URLSearchParams(location.search).has('webgl')
});
renderer.bounces = 6;
renderer.maxSamples = 1024;

function resize() {
  const ratio = Math.min(window.devicePixelRatio, 2);
  renderer.setSize(canvas.clientWidth * ratio, canvas.clientHeight * ratio);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  controls.aspect = camera.aspect;
}
window.addEventListener('resize', resize);
resize();

function frame() {
  controls.update();
  const status = renderer.render(scene, camera);
  showStatus(statusElement, renderer, status);
  requestAnimationFrame(frame);
}
frame();
