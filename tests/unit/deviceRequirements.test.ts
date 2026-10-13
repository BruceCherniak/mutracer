import {afterEach, expect, it, vi} from 'vitest';
import Engine from '../../src/Engine';
import {getRecommendedDeviceDescriptor, minimumDeviceLimits} from '../../src/renderer/deviceRequirements';
import {makeWGPURenderTargets} from '../../src/renderer/WGPURenderingPipeline';
vi.mock('../../src/renderer/WGPURenderingPipeline', () => ({makeWGPURenderTargets: vi.fn(() => ({dispose: vi.fn(), setTextureAtlasBudget: vi.fn(), setMeshes: vi.fn(), setLights: vi.fn(), setBackground: vi.fn()}))}));
const canvas = {width: 16, height: 16} as HTMLCanvasElement;
function device(limits = minimumDeviceLimits) {return {limits, features: new Set(), destroy: vi.fn(), lost: new Promise(() => {})} as unknown as GPUDevice;}
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});
it('rejects every missing limit with required and actual values through the same error outlet', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const gpu = device(Object.fromEntries(Object.keys(minimumDeviceLimits).map(key => [key, -1])) as unknown as typeof minimumDeviceLimits);
  const engine = new Engine({canvas, device: gpu}); const listener = vi.fn();engine.on('error', listener);
  await expect(engine.init()).rejects.toThrow('maxStorageBuffersPerShaderStage: requires 8, actual -1');
  for (const [key,value] of Object.entries(minimumDeviceLimits)) expect(engine.lastError!.message).toContain(`${key}: requires ${value}, actual -1`);
  expect(listener).toHaveBeenCalledWith(engine.lastError);expect(makeWGPURenderTargets).not.toHaveBeenCalled();engine.dispose();
});
it('rejects a supplied device with webgl before initialization', () => {
  expect(() => new Engine({canvas, device: device(), backend: 'webgl'})).toThrow('webgl');
});
it('uses a supplied device without navigator and never destroys it', async () => {
  vi.stubGlobal('navigator', undefined); const gpu = device();const engine = new Engine({canvas, device: gpu});
  const info = await engine.init();expect(info.backend).toBe('webgpu');expect(info.adapterName).toBe('WebGPU');
  expect(engine.device).toBe(gpu);engine.dispose();expect(gpu.destroy).not.toHaveBeenCalled();
});
it('requests only supported optional features and preserves the existing adapter-limit selection', () => {
  const descriptor = getRecommendedDeviceDescriptor({features: new Set(['shader-f16', 'unrelated']), limits: {maxBufferSize: 123}} as unknown as GPUAdapter);
  expect(descriptor.requiredFeatures).toEqual(['shader-f16']);expect(descriptor.requiredLimits?.maxBufferSize).toBe(123);
});
