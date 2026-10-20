import {expect, it, vi} from 'vitest';
import {retainedSceneParameters, sceneMaterialParameters, releaseSceneParameters} from '../../native/src/scene-core';
import {HEADER as H, GEOMETRY as G, MESH as M, MATERIAL as MAT, CAMERA as C, VERSION} from '../../native/src/layout';
import * as shaderSource from '../../src/renderer/wgpuShaderSource';
import {MATERIAL_SHADER_CAPABILITIES, LIGHT_SHADER_CAPABILITIES} from '../../src/renderer/shaderCapabilities';
import {materialLayoutFields} from '../../src/renderer/materialLayoutSchema';

function triangleScene() {
  const geometry = H.WORDS, mesh = geometry + G.WORDS, material = mesh + M.WORDS;
  const camera = material + MAT.WORDS, positions = camera + C.WORDS, indices = positions + 9;
  const bytes = new Uint8Array((indices + 3) * 4), u = new Uint32Array(bytes.buffer), f = new Float32Array(bytes.buffer);
  u[H.VERSION] = VERSION.SCENE; u[H.LENGTH] = bytes.length; u[H.WIDTH] = 8; u[H.HEIGHT] = 8;
  u[H.GEOMETRY_COUNT] = u[H.MESH_COUNT] = u[H.MATERIAL_COUNT] = 1;
  u[H.GEOMETRY_OFFSET] = geometry; u[H.MESH_OFFSET] = mesh; u[H.MATERIAL_OFFSET] = material;
  u[H.CAMERA_OFFSET] = camera;
  u[geometry + G.VERTEX_COUNT] = u[geometry + G.INDEX_COUNT] = 3;
  u[geometry + G.POSITION] = positions; u[geometry + G.INDICES] = indices;
  f.set([-1, -1, 0, 1, -1, 0, 0, 1, 0], positions); u.set([0, 1, 2], indices);
  f.set([.6, .3, .15], material + MAT.BASE_COLOR);
  f[material + MAT.ROUGHNESS] = .3; f[material + MAT.IOR] = 1.5; f[material + MAT.OPACITY] = 1;
  for (const slot of [MAT.MAP, MAT.NORMAL_MAP, MAT.METALLIC_ROUGHNESS_MAP, MAT.EMISSIVE_MAP]) u[material + slot] = 0xffffffff;
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  f.set(identity, mesh + M.TRANSFORM); f.set(identity, camera + C.TRANSFORM);
  f[camera + C.TRANSFORM + 14] = 3; f[camera + C.FOV] = 45;
  f[camera + C.NEAR] = .1; f[camera + C.FAR] = 100; f[camera + C.ZOOM] = 1;
  f[camera + C.FOCUS_DISTANCE] = 3; f[camera + C.SENSOR_HEIGHT] = .024; f[camera + C.METERS_PER_UNIT] = 1;
  return bytes;
}

it('keeps native scalar transport edits available in the original pipeline', () => {
  const token = 4810, generate = vi.spyOn(shaderSource, 'wgpuShaderSource');
  try {
    const scene = retainedSceneParameters(triangleScene(), token);
    expect(new Uint32Array(scene.buffer)[0]).toBe(1);
    const constants = generate.mock.calls[0][0];
    const shaderCalls = generate.mock.calls.length;
    const edit = new Uint8Array(48), u = new Uint32Array(edit.buffer), f = new Float32Array(edit.buffer);
    u[0] = 1; f.set([.6, .3, .15, .3, 1, 1, 1.5], 4);
    const update = sceneMaterialParameters(edit, token);
    expect(new Uint32Array(update.buffer)[0]).toBe(1);
    const packed = new Float32Array(update.buffer, 16);
    for (const [name, capability] of [['metallic', MATERIAL_SHADER_CAPABILITIES.metal],
      ['transmission', MATERIAL_SHADER_CAPABILITIES.transmission]] as const) {
      expect(packed[materialLayoutFields().find(field => field.name === name)!.offset / 4]).toBe(1);
      expect(Number(constants.MATERIAL_CAPABILITIES) & capability).toBe(capability);
    }
    expect(generate.mock.calls.length).toBe(shaderCalls);
    // Vertex updates can make previously degenerate emissive triangles sampleable.
    expect(Number(constants.LIGHT_CAPABILITIES) & LIGHT_SHADER_CAPABILITIES.emissive)
      .toBe(LIGHT_SHADER_CAPABILITIES.emissive);
  } finally {releaseSceneParameters(token); vi.restoreAllMocks();}
});
