import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mat4 } from 'gl-matrix';
import { CaptureDevice, installWebGPUConstants } from './capture-device.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.MUTRACER_NATIVE_OUTPUT ?? '.native-build', 'scene');
mkdirSync(output, { recursive: true });
installWebGPUConstants();
const { default: RayTracePass } = await import('../lib/renderer/WGPURayTracePass.js');
const { default: Mesh } = await import('../lib/scene/Mesh.js');
const { default: Material } = await import('../lib/scene/OpenPBRMaterial.js');
const { default: Camera } = await import('../lib/scene/Camera.js');
const { default: RectLight } = await import('../lib/scene/RectLight.js');
const { createSphereGeometry, createPlaneGeometry, createCubeGeometry } = await import('../lib/util/commonGeometry.js');
const { materialLayoutFields, MATERIAL_FLOAT_COUNT } = await import('../lib/renderer/materialLayout.js');
const width = 480, height = 320;
const fixture = process.env.MUTRACER_NATIVE_FIXTURE ?? 'baseline';
if (!['baseline', 'transforms'].includes(fixture)) throw new Error(`Unknown native fixture: ${fixture}`);
const device = new CaptureDevice();
const pass = new RayTracePass(device);
const floor = new Mesh(createPlaneGeometry(), new Material({ baseColor: [.55, .57, .6], specularRoughness: .65 }));
// The plane has y=0; uniform scale keeps identical world geometry while keeping
// the baseline fixture within the validated closest-hit transform scope.
mat4.fromScaling(floor.transform, [5, 5, 5]);
const geometry = createSphereGeometry(32, 20);
const spheres = [
  { x: -1.2, props: { baseColor: [.8, .08, .04], specularRoughness: .35 } },
  { x: 0, props: { baseColor: [.95, .7, .25], baseMetalness: 1, specularRoughness: .2 } },
  { x: 1.2, props: { baseColor: [.85, .95, 1], transmissionWeight: 1, specularRoughness: .05 } }
].map(({ x, props }) => {
  const mesh = new Mesh(geometry, new Material(props));
  mat4.fromTranslation(mesh.transform, [x, .55, 0]);
  mat4.scale(mesh.transform, mesh.transform, [.55, .55, .55]);
  return mesh;
});
const cube = new Mesh(createCubeGeometry(), new Material({ baseColor: [.05, .25, .75], specularRoughness: .35 }));
mat4.fromTranslation(cube.transform, [-.65, .3, -1.35]);
mat4.scale(cube.transform, cube.transform, [.3, .3, .3]);
if (fixture === 'transforms') {
  spheres.forEach((mesh, i) => {
    mat4.fromTranslation(mesh.transform, [(i - 1) * 1.25, .72, -.25]);
    mat4.rotateZ(mesh.transform, mesh.transform, (i - 1) * .35);
    mat4.rotateY(mesh.transform, mesh.transform, .4 + i * .2);
    mat4.scale(mesh.transform, mesh.transform, [i === 1 ? -.6 : .6, .85, .38]);
  });
  mat4.rotateY(cube.transform, cube.transform, .55);
  cube.transform[4] += .12; // Nonorthogonal affine instance, not just TRS.
}
const light = new RectLight({ size: [2.5, 2.5], intensity: 7, color: [1, .9, .78] });
mat4.fromTranslation(light.transform, [-1.5, 3, 1.5]);
mat4.rotateX(light.transform, light.transform, -Math.PI / 2);
const camera = new Camera({ projection: 'perspective', fov: 40, near: .1, far: 100 });
mat4.targetTo(camera.transform, [0, 2.4, 6], [0, .4, -.3], [0, 1, 0]);
pass.setSize(width, height);
pass.setCamera(camera);
pass.setMeshes([floor, ...spheres, cube]);
pass.setLights([light]);
pass.setBackground([.055, .075, .11, 1]);
pass.setQuality({ bounces: 6, bevel: false, dispersionWavelengths: 1, directLightCandidates: 2 });
pass.setSamplingPattern('sobol', 64, 12345);
pass.setSampleTiles(1, 1, 0, 0);
pass.setSampleCount(0);
pass.setJitter(.5, .5);
await pass.updatePipeline();
if (!pass.isPipelineReady()) throw pass.getPipelineError() ?? new Error('Capture preparation failed.');
pass.createPass(device.createCommandEncoder(), true, [1, 1]);

function save(name, data) { writeFileSync(resolve(output, name), data); return name; }
const pipeline = device.resources.findLast(resource => resource.kind === 'pipeline');
const groups = pass._rayTraceBindGroups;
const buffers = [], textures = [], samplers = [];
for (const resource of device.resources) {
  if (resource.kind === 'buffer') buffers.push({ id: resource.id, size: resource.size,
    usage: resource.descriptor.usage, file: save(`buffer-${resource.id}.bin`, resource.data) });
  if (resource.kind === 'texture') textures.push({ id: resource.id, width: resource.width,
    height: resource.height, depth: resource.depthOrArrayLayers, format: resource.format,
    usage: resource.descriptor.usage, writes: resource.writes.map((write, index) => ({
      origin: write.origin, size: write.size, layout: write.layout,
      file: save(`texture-${resource.id}-${index}.bin`, write.data)
    })) });
  if (resource.kind === 'sampler') samplers.push({ id: resource.id, ...resource.descriptor });
}
const bindGroups = groups.map(group => ({
  layout: group.descriptor.layout.descriptor.entries,
  entries: group.descriptor.entries.map(({ binding, resource }) => ({ binding,
    ...(resource.buffer ? { kind: 'buffer', id: resource.buffer.id } : resource.kind === 'view'
      ? { kind: 'texture', id: resource.texture.id, options: resource.options }
      : { kind: 'sampler', id: resource.id })
  }))
}));
const manifest = { format: 1, fixture, width, height, samples: 64,
  provenance: 'Build-time JavaScript scene/BVH packing and unmodified MuTracer WGSL; GPU execution is native.',
  shader: save('raytrace.wgsl', pipeline.descriptor.compute.module.descriptor.code),
  entryPoint: pipeline.descriptor.compute.entryPoint,
  buffers, textures, samplers, bindGroups,
  rtUniform: pass._uniforms.rtUniform.id, colorOutput: pass.getOutputBuffer().color.id,
  normalOutput: pass.getOutputBuffer().normal.id, albedoOutput: pass.getOutputBuffer().albedo.id,
  cameraUniform: pass._uniforms.cameraUniform.id, materialBuffer: pass._materialsBuffer.id,
  materialCount: pass._preparedMeshData.materials.length,
  materialStride: MATERIAL_FLOAT_COUNT * 4,
  materialOffsets: {
    color: materialLayoutFields().find(field => field.source === 'color').offset,
    roughness: materialLayoutFields().find(field => field.source === 'roughness').offset
  }
};
const prepared = pass._preparedMeshData;
if (!pass._hasDisplacement && prepared.blases.every(({ bvh }) => bvh.builder === 'builtin' && bvh.layout === 'bvh2')) {
  const prefixBytes = pass._rtUniform.views.blasOffset[0] * 16;
  let offset = prefixBytes;
  manifest.nativeBvh = {
    buffer: pass._bvhBuffer.id, size: pass._bvhBuffer.size,
    prefix: save('native-bvh-tlas.bin', pass._bvhBuffer.data.subarray(0, prefixBytes)),
    geometries: prepared.geometries.map((geometry, index) => {
      const bvh = prepared.blases[index].bvh;
      const positions = Float32Array.from(geometry.position.array);
      const indices = Uint32Array.from(geometry.indices.array);
      const item = { positions: save(`native-positions-${index}.bin`, new Uint8Array(positions.buffer)),
        indices: save(`native-indices-${index}.bin`, new Uint8Array(indices.buffer)),
        stride: geometry.position.itemSize, offset, size: bvh.buffer.byteLength, maxDepth: bvh.maxDepth };
      offset += bvh.buffer.byteLength;
      return item;
    })
  };
}
manifest.sampling = { maxSamples: 64, pattern: 'sobol' };
save('scene.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${output}: ${buffers.length} buffers, ${textures.length} textures, ${bindGroups.length} groups`);
