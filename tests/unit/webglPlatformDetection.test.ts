import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('does not create WebGL contexts when importing the package on an Intel Mac', async () => {
  vi.resetModules();
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  const createElement = vi.fn();
  vi.stubGlobal('document', { createElement });
  await import('../../src/main');
  expect(createElement).not.toHaveBeenCalled();
});

it.each(['AMD Radeon', 'Apple M3', 'Apple GPU'])('caches detection for %s until WebGL needs it', async gpu => {
  vi.resetModules();
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  const getContext = vi.fn(() => ({
    getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 1 }),
    getParameter: () => gpu
  }));
  const createElement = vi.fn(() => ({ getContext }));
  vi.stubGlobal('document', { createElement });
  const { isIntelMac } = await import('../../src/renderer/util');
  const { default: createShader } = await import('../../src/renderer/glsl/rayTrace.frag');
  expect(createElement).not.toHaveBeenCalled();
  createShader();
  expect(isIntelMac()).toBe(gpu === 'AMD Radeon');
  expect(isIntelMac()).toBe(gpu === 'AMD Radeon');
  expect(getContext).toHaveBeenCalledOnce();
});
