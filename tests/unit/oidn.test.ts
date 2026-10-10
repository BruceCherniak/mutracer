import { afterEach, describe, expect, it, vi } from 'vitest';
import type Renderer from '../../src/Renderer';

const initUNetFromBuffer = vi.hoisted(() => vi.fn());
vi.mock('oidn-web', () => ({ initUNetFromBuffer }));

import {
  initializeOIDN,
  initializeOIDNFromURL,
  resolveOIDNAuxiliaryModelUrls,
  resolveOIDNModelUrl
} from '../../src/oidn';
import { VERSION } from '../../src/version';

function createRenderer(usingWebGPU = true) {
  return {
    getGPUDeviceAndAdapter: vi.fn().mockResolvedValue({
      device: usingWebGPU ? ({} as GPUDevice) : undefined,
      adapterInfo: usingWebGPU ? ({} as GPUAdapterInfo) : undefined
    }),
    isUsingWebGPU: vi.fn(() => usingWebGPU),
    getSize: vi.fn(() => ({ width: 1280, height: 720 })),
    oidn: undefined,
    samplingPattern: 'sobol'
  } as unknown as Renderer;
}

describe('initializeOIDN', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['sobol', 'zsobol', 'random'] as const)('attaches OIDN without changing %s sampling', async pattern => {
    const renderer = createRenderer();
    renderer.samplingPattern = pattern;
    const weights = new ArrayBuffer(16);
    const denoiser = {
      dispose: vi.fn(),
      prepareForImage: vi.fn().mockResolvedValue(undefined),
      tileExecute: vi.fn()
    };
    const albedoDenoiser = {
      dispose: vi.fn(),
      prepareForImage: vi.fn().mockResolvedValue(undefined),
      tileExecute: vi.fn()
    };
    const normalDenoiser = {
      dispose: vi.fn(),
      prepareForImage: vi.fn().mockResolvedValue(undefined),
      tileExecute: vi.fn()
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(weights)
      })
    );
    initUNetFromBuffer
      .mockResolvedValueOnce(denoiser)
      .mockResolvedValueOnce(albedoDenoiser)
      .mockResolvedValueOnce(normalDenoiser);

    await expect(
      initializeOIDN(renderer, {
        model: 'cleanAuxLarge',
        maxTileSize: 1024,
        weightsBaseUrl: '/oidn/weights/'
      })
    ).resolves.toBe(denoiser);

    expect(fetch).toHaveBeenCalledWith(
      '/oidn/weights/rt_hdr_calb_cnrm_large.tza',
      { signal: undefined }
    );
    expect(fetch).toHaveBeenCalledWith('/oidn/weights/rt_alb_large.tza', {
      signal: undefined
    });
    expect(fetch).toHaveBeenCalledWith('/oidn/weights/rt_nrm_large.tza', {
      signal: undefined
    });
    expect(renderer.samplingPattern).toBe(pattern);
    expect(renderer.oidn).toBe(denoiser);
    expect(renderer.oidn?.auxiliaryDenoisers).toEqual({
      albedo: albedoDenoiser,
      normal: normalDenoiser
    });
    for (const filter of [denoiser, albedoDenoiser, normalDenoiser]) {
      expect(filter.prepareForImage).toHaveBeenCalledWith(1280, 720);
    }
    expect(initUNetFromBuffer).toHaveBeenCalledWith(
      weights,
      { device: {} },
      expect.objectContaining({ aux: true, hdr: true, hdrTransfer: 'pu', maxTileSize: 1024 })
    );
    expect(initUNetFromBuffer).toHaveBeenNthCalledWith(
      2,
      weights,
      { device: {} },
      expect.objectContaining({ aux: false, hdr: false, maxTileSize: 1024 })
    );
    expect(initUNetFromBuffer).toHaveBeenNthCalledWith(
      3,
      weights,
      { device: {} },
      expect.objectContaining({ aux: false, hdr: false, maxTileSize: 1024 })
    );
  });

  it('can load a custom model URL without attaching it', async () => {
    const renderer = createRenderer();
    const denoiser = { dispose: vi.fn(), tileExecute: vi.fn() };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1))
      })
    );
    initUNetFromBuffer.mockResolvedValue(denoiser);

    await initializeOIDNFromURL(renderer, '/custom/model.tza', {
      attach: false,
      aux: false,
      hdr: true,
      hdrTransfer: 'log'
    });

    expect(renderer.samplingPattern).toBe('sobol');
    expect(renderer.oidn).toBeUndefined();
    expect(initUNetFromBuffer).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      { device: {} },
      expect.objectContaining({ aux: false, hdr: true, hdrTransfer: 'log', maxTileSize: undefined })
    );
  });

  it('resolves the packaged realtime small model', () => {
    expect(resolveOIDNModelUrl('small', '/assets/oidn')).toBe(
      '/assets/oidn/rt_hdr_alb_nrm_small.tza'
    );
  });

  it('reports WebGPU and HTTP failures clearly', async () => {
    const webglRenderer = createRenderer(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      initializeOIDN(webglRenderer)
    ).rejects.toThrow('OIDN requires a WebGPU renderer.');
    expect(fetchMock).not.toHaveBeenCalled();

    const webgpuRenderer = createRenderer();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found'
    });
    await expect(
      initializeOIDNFromURL(webgpuRenderer, '/custom/missing.tza')
    ).rejects.toThrow(
      'Failed to load OIDN weights from /custom/missing.tza: 404 Not Found'
    );
  });

  it('resolves packaged models against a custom weights directory', () => {
    expect(resolveOIDNModelUrl('standard', '/assets/oidn')).toBe(
      '/assets/oidn/rt_hdr_alb_nrm.tza'
    );
    expect(resolveOIDNAuxiliaryModelUrls('/assets/oidn')).toEqual({
      albedo: '/assets/oidn/rt_alb_large.tza',
      normal: '/assets/oidn/rt_nrm_large.tza'
    });
  });

  it('defaults to the version-pinned CDN weights', () => {
    expect(resolveOIDNModelUrl('small')).toBe(
      `https://cdn.jsdelivr.net/npm/mutracer@${VERSION}/oidn/weights/rt_hdr_alb_nrm_small.tza`
    );
  });
});
