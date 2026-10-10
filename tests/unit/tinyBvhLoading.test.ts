import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { VERSION } from '../../src/version';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('rejects an HTML fallback and loads valid wasm from the pinned CDN once', async () => {
  vi.resetModules();
  const wasm = await readFile(new URL('../../src/tinybvh/tinybvh.wasm', import.meta.url));
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response('<html>Vite fallback</html>'))
    .mockResolvedValueOnce(new Response(wasm));
  vi.stubGlobal('fetch', fetchMock);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { initializeTinyBvh } = await import('../../src/tinybvh/TinyBvhBuilder');
  await initializeTinyBvh();
  await initializeTinyBvh();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenLastCalledWith(`https://cdn.jsdelivr.net/npm/mutracer@${VERSION}/lib/tinybvh/tinybvh.wasm`);
  expect(warning).toHaveBeenCalledOnce();
  expect(warning.mock.calls[0][0]).toContain('optimizeDeps');
});

it('rejects invalid content from the fallback instead of compiling HTML', async () => {
  vi.resetModules();
  const fetchMock = vi.fn().mockImplementation(async () => new Response('<html>missing</html>'));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { initializeTinyBvh } = await import('../../src/tinybvh/TinyBvhBuilder');
  await expect(initializeTinyBvh()).rejects.toThrow('non-WASM content');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
