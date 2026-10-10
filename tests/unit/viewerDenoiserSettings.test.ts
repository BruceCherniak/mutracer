import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDenoiserOptions } from '../../viewer/src/engine/denoiserSettings';
vi.mock('@meimu/mutracer', async () => import('../../src/main'));

const renderKey = 'mutracer-viewer:render:v5';
let values: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  values = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal('location', { hash: '' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('viewer denoiser preferences', () => {
  it('defaults to OIDN on WebGPU and falls back to JNLM on WebGL', async () => {
    const { useViewer } = await import('../../viewer/src/store');
    const settings = useViewer.getState().settings;
    expect(settings).toMatchObject({ denoise: true, denoiseModel: 'standard', oidnModel: 'standard' });
    expect(getDenoiserOptions(settings, true, '/weights/')).toMatchObject({ type: 'oidn', model: 'standard' });
    expect(getDenoiserOptions(settings, false, '/weights/')).toMatchObject({ type: 'jnlm' });
  });

  it('restores legacy OIDN models and remembers both configurations across reloads', async () => {
    values.set(renderKey, JSON.stringify({ denoiseModel: 'small' }));
    const { useViewer, setSettings } = await import('../../viewer/src/store');
    expect(useViewer.getState().settings.oidnModel).toBe('small');
    setSettings({ denoiseModel: 'jnlm', jnlmSearchRadius: 8, jnlmStrength: 1.4, oidnMaxTileSize: 512 });
    vi.resetModules();
    const reloaded = await import('../../viewer/src/store');
    const s = reloaded.useViewer.getState().settings;
    expect(s).toMatchObject({ denoiseModel: 'jnlm', oidnModel: 'small', jnlmSearchRadius: 8, jnlmStrength: 1.4, oidnMaxTileSize: 512 });
    reloaded.setSettings({ denoiseModel: s.oidnModel });
    expect(reloaded.useViewer.getState().settings).toMatchObject({ denoiseModel: 'small', jnlmStrength: 1.4 });
  });

  it('sanitizes invalid stored and edited denoiser values', async () => {
    values.set(renderKey, JSON.stringify({ denoiseModel: 'unknown', jnlmSearchRadius: 90, jnlmPatchRadius: -1, jnlmIterations: 2.3, jnlmNormalBandwidth: null }));
    const { useViewer, setSettings } = await import('../../viewer/src/store');
    expect(useViewer.getState().settings).toMatchObject({ denoiseModel: 'standard', jnlmSearchRadius: 16, jnlmPatchRadius: 0, jnlmIterations: 2, jnlmNormalBandwidth: 0.05 });
    setSettings({ jnlmStrength: NaN, jnlmAlbedoBandwidth: Infinity });
    expect(useViewer.getState().settings).toMatchObject({ jnlmStrength: 1, jnlmAlbedoBandwidth: 0.4 });
  });

  it('forwards active parameters and uses JNLM on WebGL without losing OIDN choices', async () => {
    const { DEFAULT_SETTINGS } = await import('../../viewer/src/store');
    const s = { ...DEFAULT_SETTINGS, denoiseModel: 'small' as const, oidnMaxTileSize: 512, denoiseWhileConverging: true, jnlmStrength: 1.7, jnlmIterations: 3 };
    expect(getDenoiserOptions(s, true, '/weights/')).toEqual({ type: 'oidn', model: 'small', maxTileSize: 512, weightsBaseUrl: '/weights/', whileConverging: true });
    expect(getDenoiserOptions(s, false, '/weights/')).toEqual({ type: 'jnlm', strength: 1.7, searchRadius: 5, patchRadius: 1, albedoBandwidth: 0.4, normalBandwidth: 0.05, iterations: 3, whileConverging: true });
    expect(getDenoiserOptions({ ...s, jnlmStrength: 2 }, true, '/weights/')).toEqual(getDenoiserOptions(s, true, '/weights/'));
    expect(getDenoiserOptions({ ...s, denoise: false }, true, '/weights/')).toBe(false);
  });
});
