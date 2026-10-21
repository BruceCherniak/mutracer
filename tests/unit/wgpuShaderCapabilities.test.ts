import {describe, expect, it} from 'vitest';
import {WGPUShaderCapabilities} from '../../src/renderer/WGPUShaderCapabilities';

const capabilities = (scene: number, material = 0, light = 0) => ({SCENE_CAPABILITIES: scene, MATERIAL_CAPABILITIES: material, LIGHT_CAPABILITIES: light});

describe('WebGPU capability variants', () => {
  it('prefers exact support, then a small compatible superset within the same structure', () => {
    const cache = new WGPUShaderCapabilities();
    const lean = capabilities(1), combined = capabilities(3), broad = capabilities(7, 3, 31);
    cache.remember('opaque', lean); cache.remember('opaque', combined); cache.remember('opaque', broad);
    expect(cache.find('opaque', capabilities(1))).toBe(lean);
    expect(cache.find('opaque', capabilities(2))).toBe(combined);
    expect(cache.find('opaque', capabilities(4, 1, 2))).toBe(broad);
    expect(cache.find('opaque', capabilities(8))).toBeUndefined();
    expect(cache.find('spectral', capabilities(1))).toBeUndefined();
  });

  it('keeps recently used support and evicts the least recently used record', () => {
    const cache = new WGPUShaderCapabilities(2);
    const a = capabilities(1), b = capabilities(2), c = capabilities(4);
    cache.remember('opaque', a); cache.remember('opaque', b);
    expect(cache.find('opaque', a)).toBe(a);
    cache.remember('opaque', c);
    expect(cache.find('opaque', b)).toBeUndefined();
    expect(cache.find('opaque', a)).toBe(a);
    expect(cache.find('opaque', c)).toBe(c);
    cache.clear();
    expect(cache.find('opaque', a)).toBeUndefined();
  });
});
