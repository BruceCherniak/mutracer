import { describe, expect, it } from 'vitest';
import { parse, parseBinary } from '../../src/util/loadGLTF';

interface FixtureMaterial {
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    metallicFactor?: number;
    roughnessFactor?: number;
  };
  doubleSided?: boolean;
  alphaMode?: string;
  extensions?: Record<string, unknown>;
}

function triangleFixture() {
  const buffer = new ArrayBuffer(72);
  new Float32Array(buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Uint32Array(buffer, 36, 3).set([0, 1, 2]);
  new Int16Array(buffer, 48, 12).set([
    32_767, 0, 0, 32_767,
    0, 32_767, 0, -32_767,
    0, 0, 32_767, 32_767
  ]);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 72 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 12 },
      { buffer: 0, byteOffset: 48, byteLength: 24 }
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0]
      },
      { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR' },
      {
        bufferView: 2,
        componentType: 5122,
        count: 3,
        normalized: true,
        type: 'VEC4'
      }
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.2, 0.4, 0.6, 0.7],
          metallicFactor: 0.25,
          roughnessFactor: 0.35
        }
      }
    ] as FixtureMaterial[],
    meshes: [
      {
        name: 'Triangle',
        primitives: [{
          attributes: { POSITION: 0, TANGENT: 2 },
          indices: 1,
          material: 0
        }]
      }
    ],
    nodes: [{ mesh: 0, translation: [1, 2, 3] }],
    scenes: [{ nodes: [0] }],
    scene: 0
  };
  return { buffer, json };
}

describe('glTF parser', () => {
  it('loads mesh data, transforms and PBR factors', async () => {
    const { buffer, json } = triangleFixture();
    const result = await parse(json, [buffer], {
      includeMesh: true,
      includeTexture: false,
      includeCamera: true
    });

    expect(result.meshes).toHaveLength(1);
    const mesh = result.meshes[0];
    expect(mesh.name).toBe('Triangle');
    expect(Array.from(mesh.matrixWorld.slice(12, 15))).toEqual([1, 2, 3]);
    expect(mesh.geometry.indices.array).toBeInstanceOf(Uint16Array);
    expect(Array.from(mesh.geometry.normal.array)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(Array.from(mesh.geometry.tangent!.array)).toEqual([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1
    ]);
    expect(mesh.materials[0]).toMatchObject({
      baseColor: [0.2, 0.4, 0.6],
      opacity: 0.7,
      transmissionWeight: 0,
      baseMetalness: 0.25,
      specularRoughness: 0.35
    });
  });

  it('uses the glTF 2.0 defaults for omitted metallic-roughness factors', async () => {
    const { buffer, json } = triangleFixture();
    json.materials[0].pbrMetallicRoughness = {};
    const result = await parse(json, [buffer], {
      includeMesh: true,
      includeTexture: false,
      includeCamera: true
    });

    expect(result.meshes[0].materials[0]).toMatchObject({
      baseMetalness: 1,
      specularRoughness: 1
    });
  });

  it('loads glTF transmission, IOR, alpha and sidedness semantics', async () => {
    const { buffer, json } = triangleFixture();
    json.materials[0] = {
      doubleSided: true,
      alphaMode: 'MASK',
      extensions: {
        KHR_materials_transmission: { transmissionFactor: 0.75 },
        KHR_materials_ior: { ior: 1.33 }
      },
      pbrMetallicRoughness: {
        baseColorFactor: [0.2, 0.4, 0.6, 0.7]
      }
    };
    const result = await parse(json, [buffer], {
      includeMesh: true,
      includeTexture: false,
      includeCamera: true
    });

    expect(result.meshes[0].materials[0]).toMatchObject({
      opacity: 0.7,
      alphaMode: 'mask',
      alphaCutoff: 0.5,
      doubleSided: true,
      specularIor: 1.33,
      mapAlphaUsage: 2,
      transmissionWeight: 0.75
    });
  });

  it('rejects glTF 1 binary containers', async () => {
    const buffer = new ArrayBuffer(20);
    new Uint32Array(buffer, 0, 4).set([0x46546c67, 1, 20, 0]);
    await expect(parseBinary(buffer, {})).rejects.toBe('Only glTF2.0 is supported.');
  });
});
