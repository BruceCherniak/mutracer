import { describe, expect, it, vi } from 'vitest';

const { initializeOIDN } = vi.hoisted(() => ({ initializeOIDN: vi.fn() }));
vi.mock('../../src/oidn', () => ({ initializeOIDN }));

const { default: Renderer } = await import('../../src/Renderer');

function fakeDenoiser() {
  return { dispose: vi.fn(), tileExecute: vi.fn() };
}

function createRenderer() {
  return new Renderer({ canvas: { width: 0, height: 0 } as HTMLCanvasElement });
}

describe('Renderer.setDenoiser', () => {
  it('loads the requested model without letting OIDN attach itself', async () => {
    const denoiser = fakeDenoiser();
    initializeOIDN.mockResolvedValueOnce(denoiser);
    const renderer = createRenderer();

    await renderer.setDenoiser({ model: 'small', realtime: true });

    expect(initializeOIDN).toHaveBeenLastCalledWith(renderer, {
      model: 'small',
      attach: false
    });
    expect(renderer.oidn).toBe(denoiser);
    expect(renderer.oidnRealtime).toBe(true);
  });

  it('disposes the replaced denoiser and detaches on disable', async () => {
    const first = fakeDenoiser();
    const second = fakeDenoiser();
    initializeOIDN.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const renderer = createRenderer();

    await renderer.setDenoiser();
    await renderer.setDenoiser({ model: 'cleanAuxLarge' });
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(renderer.oidn).toBe(second);

    await renderer.setDenoiser(false);
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(renderer.oidn).toBeUndefined();
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
});
