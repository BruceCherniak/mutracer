import { getGeometryBvh } from '../../src/renderer/geometryBvh.js';
import { beforeEach, expect, it, vi } from 'vitest';
import Renderer from '../../src/Renderer';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { createCubeGeometry } from '../../src/util/commonGeometry';
import { buildBLAS } from '../../src/renderer/bvhAccel';
import { buildTinyBvh } from '../../src/tinybvh/TinyBvhBuilder';

vi.mock('../../src/tinybvh/TinyBvhBuilder', () => ({
  buildTinyBvh: vi.fn(async (geometry, scale, displacement, layout) => ({
    ...buildBLAS(geometry, scale, displacement), builder: 'tinybvh', layout, bvhTimeMs: 1
  }))
}));
beforeEach(() => { vi.mocked(buildTinyBvh).mockClear(); });

function createRenderer() {
  return new Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
}

it('builds with the built-in builder by default without loading TinyBVH', async () => {
  const renderer = createRenderer();
  expect(renderer.bvhBuilder).toBe('builtin');
  const mesh = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
  await renderer.prepareScene([mesh]);
  expect(getGeometryBvh(mesh.geometry)?.builder).toBe('builtin');
  expect(buildTinyBvh).not.toHaveBeenCalled();
});

it('passes the spatial split option to TinyBVH preparation', async () => {
  const renderer = createRenderer();
  renderer.bvhBuilder = 'tinybvh';
  const mesh = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
  await renderer.prepareScene([mesh]);
  expect(buildTinyBvh).toHaveBeenLastCalledWith(mesh.geometry, 0, undefined, 'bvh2', false);
  renderer.bvhSpatialSplits = true;
  const other = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
  await renderer.prepareScene([other]);
  expect(buildTinyBvh).toHaveBeenLastCalledWith(other.geometry, 0, undefined, 'bvh2', true);
});
