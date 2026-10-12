// OpenPBR material gallery on a shadow catcher with a transparent background,
// OIDN denoising and deterministic offline rendering to a PNG.
import { mat4 } from 'gl-matrix';
import {
  Camera,
  CameraViewControl,
  EnvironmentLight,
  Mesh,
  OpenPBRMaterial,
  Renderer,
  SphereLight,
  type OIDNModel,
  type SamplingPattern,
  type Scene,
  createPlaneGeometry,
  createSphereGeometry
} from '@meimu/mutracer';
import { createSkyTexture } from './shared/sky';
import { showStatus } from './shared/status';

const canvas = document.getElementById('main') as HTMLCanvasElement;
const statusElement = document.getElementById('status')!;
const denoiserSelect = document.getElementById('denoiser') as HTMLSelectElement;
const samplingSelect = document.getElementById('sampling') as HTMLSelectElement;
const samplesInput = document.getElementById('samples') as HTMLInputElement;
const exportButton = document.getElementById('export') as HTMLButtonElement;

function material(props: Partial<OpenPBRMaterial>) {
  return Object.assign(new OpenPBRMaterial(), props);
}

// One sphere per OpenPBR layer.
const gallery: Partial<OpenPBRMaterial>[] = [
  // Copper.
  { baseColor: [0.95, 0.64, 0.54], baseMetalness: 1, specularRoughness: 0.3 },
  // Car paint: diffuse base under a clear coat.
  { baseColor: [0.6, 0.02, 0.04], coatWeight: 1, coatRoughness: 0.02 },
  // Dispersive glass.
  { transmissionWeight: 1, specularRoughness: 0, specularIor: 1.6,
    transmissionDispersionScale: 1, transmissionDispersionAbbeNumber: 25 },
  // Jade: subsurface scattering.
  { subsurfaceWeight: 1, subsurfaceColor: [0.35, 0.8, 0.5], subsurfaceRadius: 0.3,
    baseColor: [0.35, 0.8, 0.5], specularRoughness: 0.15 },
  // Velvet: fuzz layer.
  { baseColor: [0.15, 0.05, 0.3], fuzzWeight: 1, fuzzColor: [0.7, 0.5, 1], fuzzRoughness: 0.6 },
  // Soap-bubble iridescence: thin film over a dark base.
  { baseColor: [0.02, 0.02, 0.02], specularRoughness: 0.1, thinFilmWeight: 1,
    thinFilmThickness: 0.45, thinFilmIor: 1.33 }
];
const sphere = createSphereGeometry(64, 32);
const meshes = gallery.map((props, index) => {
  const mesh = new Mesh(sphere, material(props));
  const x = (index % 3 - 1) * 1.15;
  const z = Math.floor(index / 3) * -1.15 + 0.5;
  mat4.fromTranslation(mesh.transform, [x, 0.45, z]);
  mat4.scale(mesh.transform, mesh.transform, [0.45, 0.45, 0.45]);
  return mesh;
});

// The shadow catcher is invisible but keeps the shadows, so the render can be
// composited over any page or photo.
const floor = new Mesh(createPlaneGeometry(), material({ shadowCatcher: true }));
mat4.fromScaling(floor.transform, [8, 1, 8]);

const scene: Scene = {
  meshes: [floor, ...meshes],
  lights: [
    new EnvironmentLight(createSkyTexture({ sunIntensity: 800 })),
    new SphereLight([-2, 3, 2], [1, 0.85, 0.7], 30, 0.3)
  ],
  // Fully transparent background.
  background: [0, 0, 0, 0]
};

const camera = new Camera('perspective', 35, 1, 0.1, 100);
Camera.lookAt(camera, [0, 2.6, 5.2], [0, 0.3, -0.3]);
// Treat the scene as a tabletop: one unit is 10 cm.
camera.metersPerUnit = 0.1;
camera.fStop = 5.6;
camera.focusDistance = 5.4;
const controls = new CameraViewControl({ camera, domElement: canvas });

const renderer = new Renderer({ canvas });
renderer.bounces = 8;
renderer.maxSamples = 256;
renderer.toneMapping = 'agx';

// The dev server serves the repository root, so the packaged OIDN weights
// are available locally. Applications can omit weightsBaseUrl to use the
// CDN copy. The built-in JNLM filter needs no weights.
async function updateDenoiser() {
  const model = denoiserSelect.value;
  await renderer.setDenoiser(
    model === 'off'
      ? false
      : model === 'jnlm'
      ? { type: 'jnlm' }
      : { model: model as OIDNModel, weightsBaseUrl: '/oidn/weights/' }
  );
}
denoiserSelect.addEventListener('change', () => {
  updateDenoiser().catch(console.error);
});
updateDenoiser().catch(console.error);

// Sobol suits OIDN; ZSobol gives blue-noise error for undenoised previews.
samplingSelect.addEventListener('change', () => {
  renderer.samplingPattern = samplingSelect.value as SamplingPattern;
});

function resize() {
  const ratio = Math.min(window.devicePixelRatio, 2);
  renderer.setSize(canvas.clientWidth * ratio, canvas.clientHeight * ratio);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  controls.aspect = camera.aspect;
}
window.addEventListener('resize', resize);
resize();

let exporting = false;
exportButton.addEventListener('click', async () => {
  exporting = true;
  exportButton.disabled = true;
  try {
    // Deterministic: the same scene and sample count give the same image.
    await renderer.renderOfflineFrame(scene, camera, {
      samples: Number(samplesInput.value) || 256,
      onProgress({ stage, samples, targetSamples }) {
        statusElement.textContent = stage === 'denoising'
          ? 'Denoising'
          : `Offline ${samples} / ${targetSamples} spp`;
      }
    });
    renderer.prepareForExport();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png')
    );
    if (blob) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'mutracer.png';
      link.click();
      URL.revokeObjectURL(link.href);
    }
  } finally {
    exporting = false;
    exportButton.disabled = false;
  }
});

function frame() {
  if (!exporting) {
    controls.update();
    showStatus(statusElement, renderer, renderer.render(scene, camera));
  }
  requestAnimationFrame(frame);
}
frame();
