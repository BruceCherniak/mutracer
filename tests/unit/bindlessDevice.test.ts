import {afterEach, expect, it, vi} from 'vitest';
import Engine from '../../src/Engine';
import {minimumDeviceLimits} from '../../src/renderer/deviceRequirements';
import {probeBindless} from '../../src/renderer/wgpuBindless';
import {makeWGPURenderTargets} from '../../src/renderer/WGPURenderingPipeline';
vi.mock('../../src/renderer/WGPURenderingPipeline', () => ({makeWGPURenderTargets: vi.fn(() => ({dispose:vi.fn(),setTextureAtlasBudget:vi.fn(),setMeshes:vi.fn(),setLights:vi.fn(),setBackground:vi.fn()}))}));
vi.mock('../../src/renderer/wgpuBindless', async importOriginal => ({...await importOriginal<typeof import('../../src/renderer/wgpuBindless')>(),probeBindless:vi.fn(async()=>undefined)}));
const feature='chromium-experimental-sampling-resource-table';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks();});
const canvas={width:16,height:16} as HTMLCanvasElement;
function gpuDevice(features: string[] = []) {
  let lose!: () => void;
  const device={limits:minimumDeviceLimits,features:new Set(features),destroy:vi.fn(),lost:new Promise<void>(resolve=>{lose=resolve;})} as unknown as GPUDevice;
  return {device,lose};
}
it('honors the enabled feature set of caller devices without requesting or destroying a replacement', async()=>{
  const a=gpuDevice(),b=gpuDevice([feature]);
  const atlas=new Engine({canvas,device:a.device,textureBinding:'auto'});await atlas.init();
  expect(vi.mocked(makeWGPURenderTargets).mock.calls.at(-1)?.[2]?.materialTextures?.fallbackReason).toContain('not enabled');
  const bindless=new Engine({canvas,device:b.device,textureBinding:'auto'});await bindless.init();
  expect(probeBindless).toHaveBeenCalledWith(b.device,expect.objectContaining({enable:'chromium_experimental_resource_table'}));
  expect(vi.mocked(makeWGPURenderTargets).mock.calls.at(-1)?.[2]?.materialTextures?.support?.feature).toBe(feature);
  atlas.dispose();bindless.dispose();expect(b.device.destroy).not.toHaveBeenCalled();
});
it('separates shared-device policies while sharing concurrent requests for the same policy', async()=>{
  const devices: ReturnType<typeof gpuDevice>[]=[];
  const adapter={features:new Set([feature]),limits:minimumDeviceLimits,requestDevice:vi.fn(async(desc:GPUDeviceDescriptor)=>{
    const result=gpuDevice([...desc.requiredFeatures??[]] as string[]);devices.push(result);return result.device;
  })};
  const requestAdapter=vi.fn(async()=>adapter);
  vi.stubGlobal('navigator',{gpu:{requestAdapter,getPreferredCanvasFormat:()=> 'bgra8unorm'}});
  const atlas=new Engine({canvas}),auto=new Engine({canvas,textureBinding:'auto'}),other=new Engine({canvas,textureBinding:'auto'});
  await atlas.init();await Promise.all([auto.init(),other.init()]);
  expect(requestAdapter).toHaveBeenCalledTimes(2);expect(auto.device).toBe(other.device);expect(auto.device).not.toBe(atlas.device);
  expect(adapter.requestDevice.mock.calls[0][0].requiredFeatures).not.toContain(feature);
  expect(adapter.requestDevice.mock.calls[1][0].requiredFeatures).toContain(feature);
  [atlas,auto,other].forEach(e=>e.dispose());devices.forEach(d=>d.lose());await Promise.resolve();
});
it('reports a failed sampling probe as an atlas fallback', async()=>{
  vi.mocked(probeBindless).mockResolvedValueOnce('Unsupported resource-table syntax');
  const supplied=gpuDevice([feature]);const engine=new Engine({canvas,device:supplied.device,textureBinding:'auto'});
  await engine.init();const choice=vi.mocked(makeWGPURenderTargets).mock.calls.at(-1)?.[2]?.materialTextures;
  expect(choice?.support).toBeUndefined();expect(choice?.fallbackReason).toContain('syntax');engine.dispose();
});
it('reacquires an adapter for atlas fallback after an experimental device request is rejected', async()=>{
  const fallback=gpuDevice();
  const first={features:new Set([feature]),limits:minimumDeviceLimits,requestDevice:vi.fn(async()=>{throw new Error('experimental request failed');})};
  const retry={features:new Set(),limits:minimumDeviceLimits,requestDevice:vi.fn(async()=>fallback.device)};
  const requestAdapter=vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(retry);
  vi.stubGlobal('navigator',{gpu:{requestAdapter,getPreferredCanvasFormat:()=> 'bgra8unorm'}});
  const engine=new Engine({canvas,textureBinding:'auto'});await engine.init();
  expect(requestAdapter).toHaveBeenCalledTimes(2);expect(retry.requestDevice).toHaveBeenCalledOnce();
  expect(vi.mocked(makeWGPURenderTargets).mock.calls.at(-1)?.[2]?.materialTextures?.fallbackReason).toContain('experimental request failed');
  engine.dispose();fallback.lose();await Promise.resolve();
});
