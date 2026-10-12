import { afterEach, expect, it, vi } from 'vitest';
const pipeline = vi.hoisted(()=>({setSize:vi.fn(),getDiagnostics:vi.fn(()=>({})),dispose:vi.fn()}));
vi.mock('../../src/renderer/webgl',async importOriginal=>({...await importOriginal<typeof import('../../src/renderer/webgl')>(),Renderer:class {gl={getExtension:()=>null,getParameter:()=> 'mock WebGL',RENDERER:0};dispose() {}}}));
vi.mock('../../src/renderer/WebGLRenderingPipeline',()=>({default:()=>pipeline}));
import Renderer, {RENDER_STATUS_ERROR,RENDER_STATUS_PREPARING} from '../../src/Renderer';
import type Camera from '../../src/scene/Camera';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('records a WebGPU initialization rejection when falling back to WebGL',async()=>{
  vi.stubGlobal('navigator',{gpu:{requestAdapter:vi.fn().mockRejectedValue(new Error('adapter unavailable'))}});
  const renderer=new Renderer({canvas:{width:1,height:1} as HTMLCanvasElement});
  expect(renderer.render({meshes:[],lights:[]},{} as Camera)).toBe(RENDER_STATUS_PREPARING);
  await renderer.getGPUDeviceAndAdapter();
  expect(renderer.getDiagnostics()?.backend).toBe('webgl');
  expect(renderer.getDiagnostics()?.webgpuFallbackReason).toBe('adapter unavailable');
});
it('records a failed fallback initialization and returns ERROR without an unhandled rejection',async()=>{
  vi.stubGlobal('navigator',{});pipeline.setSize.mockImplementationOnce(()=>{throw new Error('context failed');});
  vi.spyOn(console,'error').mockImplementation(()=>{});
  const renderer=new Renderer({canvas:{width:1,height:1} as HTMLCanvasElement,preferWebGPU:false});
  renderer.render({meshes:[],lights:[]},{} as Camera);
  await expect(renderer.getGPUDeviceAndAdapter()).rejects.toThrow('context failed');
  expect(renderer.render({meshes:[],lights:[]},{} as Camera)).toBe(RENDER_STATUS_ERROR);
  expect(renderer.lastError?.message).toBe('context failed');
});
