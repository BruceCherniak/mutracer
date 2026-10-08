import { expect, it } from 'vitest';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { createCubeGeometry } from '../../src/util/commonGeometry';
import { updateMeshInstances } from '../../src/renderer/prepareMeshBVH';
import { canUpdateGeometries, updatePreparedGeometries } from '../../src/renderer/geometryUpdates';
import { refitBLAS, DYNAMIC_BLAS_REBUILD_RATIO } from '../../src/renderer/bvhAccel';
import { precomputeTinyBvh } from '../../src/tinybvh/precomputeTinyBvh';
import { convertGeometryFromTransfer, convertGeometryToTransfer } from '../../src/util/workerHelper';

it('uses builtin BVH2 for dynamic geometry, even with an incompatible precomputed layout', async () => {
  const g = createCubeGeometry(); g.dynamic = true;
  g.bvh = {buffer:new ArrayBuffer(64),maxDepth:1,layout:'bvh4',builder:'tinybvh'};
  const mesh = new Mesh(g, new OpenPBRMaterial()); updateMeshInstances([mesh]);
  expect(g.bvh.layout).toBe('bvh2'); expect(g.bvh.builder).toBe('builtin');
  await precomputeTinyBvh([mesh], 'cwbvh');
  expect(g.bvh.layout).toBe('bvh2'); expect(g.bvh.builder).toBe('builtin');
  expect(convertGeometryFromTransfer(convertGeometryToTransfer(g, [])).dynamic).toBe(true);
});
it('rebuilds dynamic BLASes after total node area exceeds the construction baseline', () => {
  const g = createCubeGeometry(); g.dynamic = true;
  const prepared = updateMeshInstances([new Mesh(g, new OpenPBRMaterial())]);
  const old = g.bvh!, baseline = old.buildSurfaceArea!;
  for (let i = 0; i < g.position.array.length; i++) g.position.array[i] *= .99;
  expect(refitBLAS(old, g)).toBe(true); expect(old.buildSurfaceArea).toBe(baseline);
  for (let i = 0; i < g.position.array.length; i++) g.position.array[i] *= Math.sqrt(DYNAMIC_BLAS_REBUILD_RATIO) + .1;
  g.markUpdated(); const update = updatePreparedGeometries(prepared, new Set([g]));
  expect(g.bvh).not.toBe(old); expect(update.blases).toHaveLength(1);
  expect(g.bvh!.buildSurfaceArea).toBeGreaterThan(baseline * DYNAMIC_BLAS_REBUILD_RATIO);
});
it('updates shared geometry regions and every instance bound without merging untouched geometry', () => {
  const g = createCubeGeometry(), other = createCubeGeometry(), m = new OpenPBRMaterial();
  const a = new Mesh(g,m), b = new Mesh(g,m), c = new Mesh(other,m); b.matrixWorld[12] = 5;
  const prepared = updateMeshInstances([a,b,c]);
  const merged = prepared.geometry, old = merged.position.array.slice();
  g.position.array[0] += .1; g.normal.array[0] = .25; g.uv!.array[0] = .3; g.markUpdated();
  expect(canUpdateGeometries(prepared,[g])).toBe(true);
  const update = updatePreparedGeometries(prepared,new Set([g]));
  expect(prepared.geometry).toBe(merged); expect(update.vertices).toHaveLength(1); expect(update.meshes).toEqual(new Set([a,b]));
  expect(merged.position.array[0]).toBe(g.position.array[0]); expect(merged.normal.array[0]).toBe(.25);
  expect(merged.position.array.slice(g.position.array.length)).toEqual(old.slice(g.position.array.length));
  expect(prepared.instanceBindings[0].bvhBounds).toEqual(prepared.instanceBindings[1].bvhBounds);
  expect(prepared.instanceBindings[0].bvhBounds[1][0]).toBe(g.position.array[0]);
});
it('rebuilds an edited index stream and detects BLAS relocation without remerging attributes', () => {
  const g = createCubeGeometry(), mesh = new Mesh(g,new OpenPBRMaterial());
  const prepared = updateMeshInstances([mesh]), old = g.bvh;
  const merged = prepared.geometry;
  g.indices.array.fill(0); g.markUpdated();
  const update = updatePreparedGeometries(prepared,new Set([g]));
  expect(g.bvh).not.toBe(old); expect(update.resized).toBe(true); expect(update.relocated).toBe(true);
  expect(prepared.geometry).toBe(merged); expect(merged.indices.array.every(i => i === 0)).toBe(true);
});
it('regenerates evaluated displacement or simplification instead of uploading source vertices into their regions', () => {
  const g = createCubeGeometry(), mesh = new Mesh(g,new OpenPBRMaterial());
  const prepared = updateMeshInstances([mesh]); mesh.geometrySimplificationRatio = .5;
  expect(canUpdateGeometries(prepared,[g])).toBe(false);
});
