import { describe, expect, it, vi } from 'vitest';

const { initializeOIDN } = vi.hoisted(() => ({ initializeOIDN: vi.fn() }));
vi.mock('../../src/oidn', () => ({ initializeOIDN }));

const { default: Renderer } = await import('../../src/Renderer');

function fakeDenoiser() {
  return { dispose: vi.fn(), tileExecute: vi.fn() };
}

function denoiseMode(renderer: InstanceType<typeof Renderer>) {
  return (renderer as unknown as { _denoiseMode: Record<string, unknown> })._denoiseMode;
}

function createRenderer() {
  return new Renderer({ canvas: { width: 0, height: 0 } as HTMLCanvasElement });
}

describe('Renderer.setDenoiser', () => {
  it('loads the requested model without letting OIDN attach itself', async () => {
    const denoiser = fakeDenoiser();
    initializeOIDN.mockResolvedValueOnce(denoiser);
    const renderer = createRenderer();

    await renderer.setDenoiser({ model: 'small', whileConverging: true });

    expect(initializeOIDN).toHaveBeenLastCalledWith(renderer, {
      model: 'small',
      attach: false
    });
    expect(renderer.oidn).toBe(denoiser);
    expect(denoiseMode(renderer)).toEqual({
      whileConverging: true,
      sampleInterval: undefined,
      coalesceSceneUpdates: false
    });
  });

  it('applies the while-converging options and validates the interval', async () => {
    initializeOIDN.mockResolvedValue(fakeDenoiser());
    const renderer = createRenderer();

    await renderer.setDenoiser({ type: 'oidn', whileConverging: true, sampleInterval: 4, coalesceSceneUpdates: true, previewModel: false });
    expect(denoiseMode(renderer)).toEqual({
      whileConverging: true,
      sampleInterval: 4,
      coalesceSceneUpdates: true
    });
    await expect(renderer.setDenoiser({ type: 'oidn', sampleInterval: 0 })).rejects.toThrow('sampleInterval');

    // Disabling keeps no while-converging work running.
    await renderer.setDenoiser(false);
    expect(denoiseMode(renderer).whileConverging).toBe(false);
    initializeOIDN.mockReset();
  });

  it('disposes the replaced denoiser and detaches on disable', async () => {
    const first = fakeDenoiser();
    const second = fakeDenoiser();
    initializeOIDN.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const renderer = createRenderer();

    await renderer.setDenoiser({ type: 'oidn' });
    await renderer.setDenoiser({ model: 'cleanAuxLarge' });
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(renderer.oidn).toBe(second);

    await renderer.setDenoiser(false);
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(renderer.oidn).toBeUndefined();
  });

  it('loads a faster preview network for while-converging denoising', async () => {
    initializeOIDN.mockReset();
    const main = fakeDenoiser();
    const preview = fakeDenoiser();
    initializeOIDN.mockImplementation((_renderer, { model }) =>
      Promise.resolve(model === 'small' ? preview : main));
    const renderer = createRenderer();

    await renderer.setDenoiser({ type: 'oidn', whileConverging: true });
    expect(initializeOIDN.mock.calls.map(([, options]) => options.model)).toEqual([undefined, 'small']);
    // The preview network never replaces the attached denoiser.
    expect(renderer.oidn).toBe(main);

    // Without while-converging (or with previewModel: false) only the main network loads.
    initializeOIDN.mockClear();
    await renderer.setDenoiser({ type: 'oidn', whileConverging: false });
    await renderer.setDenoiser({ type: 'oidn', whileConverging: true, previewModel: false });
    expect(initializeOIDN).toHaveBeenCalledTimes(2);
    expect(preview.dispose).toHaveBeenCalledOnce();

    await renderer.setDenoiser(false);
    expect(renderer.oidn).toBeUndefined();
    initializeOIDN.mockReset();
  });

  it('drops a load that a newer call superseded', async () => {
    let resolveSlow!: (value: unknown) => void;
    const slow = fakeDenoiser();
    const fast = fakeDenoiser();
    initializeOIDN.mockImplementation((_renderer, { model }) =>
      model === 'small'
        ? Promise.resolve(fast)
        : new Promise((resolve) => { resolveSlow = resolve; }));
    const renderer = createRenderer();

    const pending = renderer.setDenoiser({ model: 'cleanAuxLarge' });
    await renderer.setDenoiser({ model: 'small' });
    await vi.waitFor(() => expect(resolveSlow).toBeDefined());
    resolveSlow(slow);
    await pending;

    expect(renderer.oidn).toBe(fast);
    expect(slow.dispose).toHaveBeenCalledOnce();
  });

  it('attaches the built-in JNLM filter by default without loading OIDN', async () => {
    initializeOIDN.mockReset();
    const renderer = createRenderer();

    await renderer.setDenoiser({ whileConverging: true, strength: 2 });
    expect(initializeOIDN).not.toHaveBeenCalled();
    const attached = (renderer as unknown as { _activeDenoiser: { type: string; strength: number } })._activeDenoiser;
    expect(attached).toMatchObject({ type: 'jnlm', strength: 2 });
    // `oidn` only reports OIDN networks.
    expect(renderer.oidn).toBeUndefined();
    expect(denoiseMode(renderer).whileConverging).toBe(true);
    await expect(renderer.setDenoiser({ type: 'jnlm', strength: 0 })).rejects.toThrow('strength');

    // OIDN-specific options select OIDN without an explicit type.
    const oidn = fakeDenoiser();
    initializeOIDN.mockResolvedValueOnce(oidn);
    await renderer.setDenoiser({ model: 'small' });
    expect(renderer.oidn).toBe(oidn);

    await renderer.setDenoiser(true);
    expect(oidn.dispose).toHaveBeenCalledOnce();
    expect(renderer.oidn).toBeUndefined();
  });

  it('attaches JNLM without a WebGPU device', async () => {
    const renderer = createRenderer();
    const getDevice = vi.spyOn(renderer, 'getGPUDeviceAndAdapter');
    await renderer.setDenoiser();
    expect(getDevice).not.toHaveBeenCalled();
    expect((renderer as unknown as { _activeDenoiser: { type: string } })._activeDenoiser.type).toBe('jnlm');
  });
});
