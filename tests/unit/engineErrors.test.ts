import { afterEach, expect, it, vi } from 'vitest';
const pipeline = vi.hoisted(() => ({getDiagnostics: vi.fn(() => ({})), dispose: vi.fn(), setTextureAtlasBudget: vi.fn(), setMeshes: vi.fn(), setLights: vi.fn(), setBackground: vi.fn()}));
const create = vi.hoisted(() => vi.fn(() => pipeline));
vi.mock('../../src/renderer/webgl', async importOriginal => ({...await importOriginal<typeof import('../../src/renderer/webgl')>(), WebGLDevice: class {gl = {getExtension: () => null, getParameter: () => 'mock WebGL', RENDERER: 0}; dispose() {}}}));
vi.mock('../../src/renderer/WebGLRenderingPipeline', () => ({makeWebGLRenderTargets: create}));
import Engine from '../../src/Engine';
import Render from '../../src/Render';
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
it('records a WebGPU initialization rejection when falling back to WebGL', async () => {
  vi.stubGlobal('navigator', {gpu: {requestAdapter: vi.fn().mockRejectedValue(new Error('adapter unavailable'))}});
  const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement});
  await engine.init();
  expect(engine.getDiagnostics()).toMatchObject({backend: 'webgl', webgpuFallbackReason: 'adapter unavailable'});
});
it('records failed initialization and keeps render errors synchronous after rejection', async () => {
  vi.stubGlobal('navigator', {}); create.mockImplementationOnce(() => {throw new Error('context failed');});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement, backend: 'webgl'});
  const errors = vi.fn(); engine.on('error', errors);
  await expect(engine.init()).rejects.toThrow('context failed');
  expect(new Render(engine).refine()).toBe('error'); expect(engine.lastError?.message).toBe('context failed');
  expect(errors).toHaveBeenCalledOnce();
});
it('shares concurrent initialization and exposes no backend before completion', async () => {
  vi.stubGlobal('navigator', {});
  const engine = new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement, backend: 'webgl'});
  expect(engine.info).toBeUndefined(); expect(engine.backend).toBeUndefined(); expect(engine.device).toBeUndefined();
  const first = engine.init(), second = engine.init(); expect(first).toBe(second);
  const info = await first; expect(info).toBe(engine.info); expect(await engine.init()).toBe(info);
  expect(engine.backend).toBe('webgl');
});
