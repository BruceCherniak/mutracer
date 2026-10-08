import { describe, expect, it } from 'vitest';
import { parseRGBE } from '../../src/util/loadRGBE';
import { isTextureDataSource } from '../../src/scene/Texture';

function onePixelRgbe() {
  const header = new TextEncoder().encode('#?RADIANCE\n\n-Y 1 +X 1\n');
  const bytes = new Uint8Array(header.length + 4);
  bytes.set(header);
  bytes.set([128, 64, 32, 129], header.length);
  return bytes.buffer;
}

describe('parseRGBE', () => {
  it('decodes file radiance without an implicit exposure stop', () => {
    const texture = parseRGBE(onePixelRgbe());
    expect(texture).toBeDefined();
    expect(isTextureDataSource(texture!.image)).toBe(true);
    if (!isTextureDataSource(texture!.image)) return;
    expect(Array.from(texture!.image.data)).toEqual([1, 0.5, 0.25, 1]);
  });

  it('applies an explicitly requested exposure in stops', () => {
    const texture = parseRGBE(onePixelRgbe(), 1);
    expect(texture).toBeDefined();
    if (!texture || !isTextureDataSource(texture.image)) return;
    expect(Array.from(texture.image.data)).toEqual([2, 1, 0.5, 1]);
  });
});
