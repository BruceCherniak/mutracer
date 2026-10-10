import { beforeEach, expect, it, vi } from 'vitest';
import Renderer from '../../src/Renderer';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { createCubeGeometry } from '../../src/util/commonGeometry';

const precomputeTinyBvh = vi.fn(async () => undefined);
vi.mock('../../src/tinybvh/precomputeTinyBvh', () => ({ precomputeTinyBvh }));

beforeEach(() => precomputeTinyBvh.mockClear());

function createRenderer() {
  return new Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
}

it('builds with the built-in builder by default without loading TinyBVH', async () => {
  const renderer = createRenderer();
  expect(renderer.bvhBuilder).toBe('builtin');
  await renderer.prepareScene([new Mesh(createCubeGeometry(), new OpenPBRMaterial())]);
  expect(precomputeTinyBvh).not.toHaveBeenCalled();
});

it('passes the spatial split option to TinyBVH preparation', async () => {
  const renderer = createRenderer();
  renderer.bvhBuilder = 'tinybvh';
  const mesh = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
  await renderer.prepareScene([mesh]);
  expect(precomputeTinyBvh).toHaveBeenLastCalledWith([mesh], 'bvh2', undefined, { onlyMissing: true, spatialSplits: false });

  renderer.bvhSpatialSplits = true;
  const other = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
  await renderer.prepareScene([other]);
  expect(precomputeTinyBvh).toHaveBeenLastCalledWith([other], 'bvh2', undefined, { onlyMissing: true, spatialSplits: true });
});
