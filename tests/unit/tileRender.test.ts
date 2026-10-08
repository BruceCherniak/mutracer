import { describe, expect, it } from 'vitest';
import {
  makeTileRender,
  makeTileRenderWithPredict
} from '../../src/renderer/TileRender';

describe('WebGL tile rendering', () => {
  it('starts 720p as a single tile on a modern device', () => {
    const gl = {
      MAX_RENDERBUFFER_SIZE: 0x84e8,
      getParameter: () => 16384
    } as unknown as WebGL2RenderingContext;
    const tileRender = makeTileRender(gl);
    tileRender.setSize(1280, 720);

    const tile = tileRender.nextTile(16);
    expect(tile.columns * tile.rows).toBe(1);
  });

  it('does not use a scene-update stall as the first tile measurement after reset', () => {
    const gl = {
      MAX_RENDERBUFFER_SIZE: 0x84e8,
      getParameter: () => 16384
    } as unknown as WebGL2RenderingContext;
    const renderers = [makeTileRender(gl), makeTileRender(gl)];
    for (const tiles of renderers) {
      tiles.setSize(1280, 720);
      const first = tiles.nextTile(0);
      for (let i = 0; i < first.columns * first.rows; i++) {
        tiles.nextTile(21);
      }
      tiles.reset();
    }
    expect(renderers[0].nextTile(5000)).toEqual(renderers[1].nextTile(0));
  });

  it('ignores unavailable update-frame timings and still adapts to valid slow tiles', () => {
    const tiles = makeTileRender();
    tiles.setSize(3840, 2160);
    const first = tiles.nextTile();
    const count = first.columns * first.rows;
    // Only one tile has a valid measurement. Its target-length render must
    // not be averaged with the discarded measurements as if they took 0 ms.
    for (let i = 1; i < count; i++) tiles.nextTile();
    const unchanged = tiles.nextTile(21);
    expect(unchanged).toEqual(first);
    for (let i = 1; i < count; i++) tiles.nextTile(2000);
    const slower = tiles.nextTile(2000);
    expect(slower.tileWidth * slower.tileHeight)
      .toBeLessThan(first.tileWidth * first.tileHeight);
  });
});

describe('predictive tile rendering', () => {
  it('uses a representative 4K probe instead of a 64x64 cold start', () => {
    const tileRender = makeTileRenderWithPredict();
    tileRender.setSize(3840, 2160);
    tileRender.setDesiredMsPerTile(21);
    tileRender.needsUpdatePredicting();

    const probe = tileRender.nextTile();
    expect(probe.tileWidth * probe.tileHeight).toBeGreaterThan(200000);
    expect(probe.columns * probe.rows).toBeLessThan(64);

    // A typical probe result should immediately produce a practical first
    // sample rather than needing several samples to grow out of tiny tiles.
    tileRender.setLastTraceTime(4);
    tileRender.reset();
    const firstSample = tileRender.nextTile();
    expect(firstSample.columns * firstSample.rows).toBeLessThan(16);
  });

  it('drops old timing averages when requesting a fresh prediction', () => {
    const renderers = [makeTileRenderWithPredict(), makeTileRenderWithPredict()];
    for (const tiles of renderers) {
      tiles.setSize(3840, 2160);
      tiles.setDesiredMsPerTile(21);
      tiles.nextTile();
    }
    renderers[0].setLastTraceTime(5000);
    for (const tiles of renderers) {
      tiles.reset();
      tiles.needsUpdatePredicting();
    }
    expect(renderers[0].nextTile()).toEqual(renderers[1].nextTile());
  });
});
