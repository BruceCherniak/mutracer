import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterTextures, polyHavenMaps, type PolyHavenTexture } from '../src/engine/polyHaven';

const file = (name: string, res: string) => ({ jpg: { url: `https://dl/${name}_${res}.jpg`, size: 1 } });
const sizes = (name: string, ...res: string[]) => Object.fromEntries(res.map((r) => [r, file(name, r)]));

function mockFiles(files: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(files))));
}

afterEach(() => vi.unstubAllGlobals());

describe('Poly Haven texture sets', () => {
  it('maps the packed ARM texture to the glTF metallic-roughness slot', async () => {
    mockFiles({
      Diffuse: sizes('diff', '1k', '2k'), nor_gl: sizes('nor', '1k', '2k'), nor_dx: sizes('dx', '1k'),
      arm: sizes('arm', '1k', '2k'), Rough: sizes('rough', '1k', '2k')
    });
    const { urls, metal } = await polyHavenMaps('brick', '2k');
    expect(urls).toEqual({ map: 'https://dl/diff_2k.jpg', normalMap: 'https://dl/nor_2k.jpg', metallicRoughnessMap: 'https://dl/arm_2k.jpg' });
    expect(metal).toBe(false);
  });

  it('falls back to separate maps and to the nearest smaller resolution', async () => {
    mockFiles({ Diffuse: sizes('diff', '1k', '2k'), Rough: sizes('rough', '1k'), Metal: sizes('metal', '1k') });
    const { urls, metal } = await polyHavenMaps('plate', '4k');
    expect(urls).toEqual({ map: 'https://dl/diff_2k.jpg', roughnessMap: 'https://dl/rough_1k.jpg', metalnessMap: 'https://dl/metal_1k.jpg' });
    expect(metal).toBe(true);
  });

  it('filters by every query word and by category', () => {
    const list: PolyHavenTexture[] = [
      { id: 'oak', name: 'Oak Planks', categories: ['wood', 'floor'], tags: ['brown'], downloads: 2 },
      { id: 'brick', name: 'Red Brick', categories: ['brick', 'wall'], tags: ['red'], downloads: 1 }
    ];
    expect(filterTextures(list, 'brown planks', null).map((t) => t.id)).toEqual(['oak']);
    expect(filterTextures(list, '', 'wall').map((t) => t.id)).toEqual(['brick']);
    expect(filterTextures(list, 'red', 'wood')).toEqual([]);
  });
});
