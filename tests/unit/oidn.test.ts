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
import { readFileSync } from 'node:fs';
import { OIDN_WEIGHTS_PACKAGE_VERSION, OIDN_WEIGHTS_PACKAGE, DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL, DEFAULT_OIDN_WEIGHTS_BASE_URL } from '../../src/oidn';

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
    const weights = new Uint8Array([0xD7, 0x41, 0, 0]).buffer;
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
        arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([0xD7, 0x41]).buffer)
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

  it.each(['standard', 'small'] as const)('defaults %s to a bundled asset', model => {
    expect(resolveOIDNModelUrl(model)).toMatch(new RegExp(`^file:.*?/oidn/weights/${model === 'small' ? 'rt_hdr_alb_nrm_small' : 'rt_hdr_alb_nrm'}\\.tza$`));
  });

  it('pins the complete networks to the independent weights package', () => {
    const template = JSON.parse(readFileSync(new URL('../../oidn/package/package.json', import.meta.url), 'utf8'));
    expect(OIDN_WEIGHTS_PACKAGE_VERSION).toBe(template.version);
    expect(OIDN_WEIGHTS_PACKAGE).toBe(template.name);
    expect(resolveOIDNModelUrl('cleanAuxLarge')).toBe(`${DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL}rt_hdr_calb_cnrm_large.tza`);
    expect(resolveOIDNAuxiliaryModelUrls()).toEqual({
      albedo: `${DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL}rt_alb_large.tza`,
      normal: `${DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL}rt_nrm_large.tza`
    });
  });

  it('falls back for HTML/non-TZA bundled assets and warns only once', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => url.startsWith('file:')
        ? new TextEncoder().encode('<html>Vite fallback</html>').buffer
        : new Uint8Array([0xD7, 0x41]).buffer
    }));
    vi.stubGlobal('fetch', fetchMock);
    initUNetFromBuffer.mockResolvedValue({ dispose() {} });
    try {
      for (const model of ['standard', 'small'] as const) {
        await initializeOIDN(createRenderer(), { model });
        expect(fetchMock).toHaveBeenCalledWith(resolveOIDNModelUrl(model, DEFAULT_OIDN_WEIGHTS_BASE_URL), { signal: undefined });
      }
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0][0]).toContain('optimizeDeps');
    } finally { warning.mockRestore(); }
  });

  it.each(['base', 'custom', 'aux'] as const)('does not fall back for explicit %s URLs', async kind => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    vi.stubGlobal('fetch', fetchMock);
    const renderer = createRenderer();
    const loading = kind === 'custom'
      ? initializeOIDNFromURL(renderer, '/custom.tza')
      : initializeOIDN(renderer, kind === 'base' ? { weightsBaseUrl: '/own' }
        : { model: 'cleanAuxLarge', auxiliaryModelUrls: { albedo: '/own/albedo', normal: '/own/normal' } });
    await expect(loading).rejects.toThrow();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith(DEFAULT_OIDN_WEIGHTS_BASE_URL))).toHaveLength(0);
  });

  it('rejects HTML from an explicit URL without a fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode('<html>').buffer });
    vi.stubGlobal('fetch', fetchMock);
    await expect(initializeOIDNFromURL(createRenderer(), '/own.tza')).rejects.toThrow('expected magic D7 41');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('explains how to self-host missing large networks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }));
    await expect(initializeOIDN(createRenderer(), { model: 'cleanAuxLarge' })).rejects.toThrow('Self-host node_modules/oidn-weights/*.tza and pass weightsBaseUrl');
  });
});
