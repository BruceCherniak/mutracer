import { expect, it, vi } from 'vitest';
import { buildBLAS, flattenBvh } from '../../src/renderer/bvhAccel';
import { createCubeGeometry } from '../../src/util/commonGeometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { precomputeTinyBvh } from '../../src/tinybvh/precomputeTinyBvh';

// Isolate aggregation from WASM loading; traversal is covered separately.
vi.mock('../../src/tinybvh/TinyBvhBuilder', () => ({
  initializeTinyBvh: vi.fn(async () => undefined),
  buildTinyBvh: vi.fn((geometry, scale, displacement, layout) => ({
    ...flattenBvh(buildBLAS(geometry, scale, displacement), false),
    builder: 'tinybvh', layout
  }))
}));

it('counts shared dynamic geometry once and includes its actual build timings', async () => {
  const geometry = createCubeGeometry(); geometry.dynamic = true;
  const material = new OpenPBRMaterial();
  const meshes = [new Mesh(geometry, material), new Mesh(geometry, material)];
  const built = await precomputeTinyBvh(meshes, 'cwbvh');
  expect(built.geometryCount).toBe(1); expect(built.layout).toBe('bvh2');
  expect(built.bvhBuildTimeMs).toBeGreaterThan(0);
  expect(built.bvhTimeMs).toBe(built.bvhBuildTimeMs); expect(built.bvhRefitCount).toBe(0);
  const cached = await precomputeTinyBvh(meshes);
  expect(cached.geometryCount).toBe(0); expect(cached.bvhTimeMs).toBe(0);
});

it('includes static and dynamic geometries in mixed layout statistics', async () => {
  const dynamic = createCubeGeometry(); dynamic.dynamic = true;
  const material = new OpenPBRMaterial();
  const result = await precomputeTinyBvh([new Mesh(dynamic, material), new Mesh(createCubeGeometry(), material)], 'cwbvh');
  expect(result.geometryCount).toBe(2); expect(result.layout).toBe('mixed');
  expect(dynamic.bvh!.builder).toBe('builtin'); expect(dynamic.bvh!.layout).toBe('bvh2');
  expect(result.bvhTimeMs).toBeGreaterThan(0);
  expect(result.bvhTimeMs).toBe(result.bvhBuildTimeMs + result.bvhRefitTimeMs);
});
