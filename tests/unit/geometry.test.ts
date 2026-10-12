import { packMaterialIndexAndWeightToInt, unpackMaterialIndexAndWeightFromInt } from '../../src/renderer/materialIndices.js';
import { mat4, vec3 } from '../../src/math';
import { describe, expect, it } from 'vitest';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { createCubeGeometry, createPlaneGeometry } from '../../src/util/commonGeometry';
import {
  generateVertexTangents,
  updateBoundingBox
} from '../../src/util/geometry';
import { computeMeshesBoundingBox } from '../../src/util/mesh';

describe('Geometry attributes', () => {
  it('reads values and reports vertex count', () => {
    const attribute = new Attribute(new Float32Array([1, 2, 3, 4, 5, 6]), 3);
    const item: number[] = [];
    Attribute.getItem(attribute, item, 1);
    expect(item).toEqual([4, 5, 6]);
    expect(Attribute.getCount(attribute)).toBe(2);
  });

  it('round-trips packed material weights', () => {
    const packed = packMaterialIndexAndWeightToInt(13, 0.4);
    const [index, weight] = unpackMaterialIndexAndWeightFromInt(packed);
    expect(index).toBe(13);
    expect(weight).toBeCloseTo(0.4, 2);
  });
});

describe('geometry utilities', () => {
  it('computes bounds and normals for an unindexed triangle', () => {
    const geometry = new Geometry({
      position: new Attribute(new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]), 3)
    });
    updateBoundingBox(geometry);


    expect(Array.from(geometry.boundingBox.min)).toEqual([0, 0, 0]);
    expect(Array.from(geometry.boundingBox.max)).toEqual([2, 3, 0]);
    expect(Array.from(geometry.normal.array)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('creates common geometry with stable topology', () => {
    const cube = createCubeGeometry();
    const plane = createPlaneGeometry(2, 3);
    expect(cube.vertexCount).toBe(24);
    expect(cube.indices.array).toHaveLength(36);
    expect(plane.vertexCount).toBe(12);
    expect(plane.indices.array).toHaveLength(36);
  });

  it('generates UV-aligned orthonormal tangents', () => {
    const plane = createPlaneGeometry();
    generateVertexTangents(plane);
    expect(plane.tangent).toBeDefined();
    for (let index = 0; index < plane.vertexCount; index++) {
      const offset = index * 3;
      const tangent = Array.from(plane.tangent!.array.slice(offset, offset + 3));
      expect(Math.hypot(...tangent)).toBeCloseTo(1);
      expect(tangent).toEqual([0, 0, 1]);
    }
  });

  it('merges transformed mesh bounds in world space', () => {
    const left = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
    const right = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
    mat4.translate(left.transform, left.transform, [-3, 0, 0]);
    mat4.translate(right.transform, right.transform, [2, 4, 0]);

    const bounds = computeMeshesBoundingBox([left, right]);
    expect(Array.from(bounds.min)).toEqual([-4, -1, -1]);
    expect(Array.from(bounds.max)).toEqual([3, 5, 1]);
    expect(vec3.dist(bounds.min, bounds.max)).toBeGreaterThan(0);
  });
});


it('generates indices and normals from position alone, and preserves supplied attributes', () => {
  const position = new Attribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]),3);
  const geometry = new Geometry({position});
  expect(geometry.vertexCount).toBe(3); expect(geometry.triangleCount).toBe(1);
  expect(Array.from(geometry.indices.array)).toEqual([0,1,2]);
  expect(Array.from(geometry.normal.array)).toEqual([0,0,1,0,0,1,0,0,1]);
  const supplied = new Geometry({position,indices:geometry.indices,normal:geometry.normal});
  expect(supplied.indices).toBe(geometry.indices); expect(supplied.normal).toBe(geometry.normal);
  const empty = new Geometry({position:new Attribute(new Float32Array(0),3)});
  expect(empty.normal.array).toHaveLength(0); expect(empty.triangleCount).toBe(0);
});
