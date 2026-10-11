import { describe, expect, it } from 'vitest';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import {
  getTrianglesDisplacementRange
} from '../../src/renderer/prepareMeshBVH';
import {
  prepareForPrecompute,
  precompute
} from '../../src/util/workerHelper';

function triangleGeometry() {
  return new Geometry({
    position: new Attribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    normal: new Attribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
    uv: new Attribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2),
    indices: new Attribute(new Uint32Array([0, 1, 2]), 1)
  });
}

function heightTexture(values: number[], width: number, height = width) {
  return new Texture({ data: new Float32Array(values), width, height });
}

describe('geometry precomputation', () => {
  it('propagates an external BVH builder failure without substituting a BVH', async () => {
    const prepared = prepareForPrecompute([
      new Mesh(triangleGeometry(), new OpenPBRMaterial())
    ]);
    const error = new Error('tinybvh failed');

    await expect(
      precompute(
        prepared.geometries,
        prepared.displacementScales,
        prepared.trianglesDisplacements,
        async () => {
          throw error;
        }
      )
    ).rejects.toBe(error);
  });

  it('defers projective height-range analysis to worker precompute', async () => {
    const material = new OpenPBRMaterial();
    material.displacementMap = heightTexture([0, 0.25, 0.5, 1], 2);
    material.displacementScale = 0.25;
    const source = triangleGeometry();
    const prepared = prepareForPrecompute([new Mesh(source, material)]);

    expect(prepared.projectiveDisplacements[0]).toBeDefined();
    expect(prepared.trianglesDisplacements).toEqual([undefined]);

    const result = await precompute(
      prepared.geometries,
      prepared.displacementScales,
      prepared.trianglesDisplacements,
      undefined,
      undefined,
      prepared.projectiveDisplacements
    );

    expect(result.geometries[0].bvh).toBeDefined();
  });

  it('supports projective range bounds without UVs when using triplanar projection', () => {
    const geometry = triangleGeometry();
    geometry.uv = undefined;
    const material = new OpenPBRMaterial();
    material.displacementUvProjection = 'triplanar';
    const range = getTrianglesDisplacementRange(
      geometry,
      heightTexture([0, 0.25, 0.5, 1], 2),
      material
    );

    expect(range).toBeInstanceOf(Float32Array);
    expect(range).toHaveLength(2);
  });

  it('supports projective range bounds without UVs when using cylindrical projection', () => {
    const geometry = triangleGeometry();
    geometry.uv = undefined;
    const material = new OpenPBRMaterial();
    material.displacementUvProjection = 'cylindrical';
    material.displacementUvScale = 2;
    const range = getTrianglesDisplacementRange(
      geometry,
      heightTexture([0, 0.25, 0.5, 1], 2),
      material
    );

    expect(range).toBeInstanceOf(Float32Array);
    expect(range).toHaveLength(2);
  });
});
