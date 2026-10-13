import {afterEach, expect, it, vi} from 'vitest';
vi.mock('../../src/renderer/WebGLRenderingPipeline', () => ({makeWebGLRenderTargets: vi.fn()}));
vi.mock('../../src/renderer/webgl', async importOriginal => ({...await importOriginal<typeof import('../../src/renderer/webgl')>(), WebGLDevice: class {
  gl = {getParameter: () => 8192, getExtension: () => null};dispose = vi.fn();
}}));
import Engine from '../../src/Engine';import Render from '../../src/Render';
import {makeWebGLRenderTargets} from '../../src/renderer/WebGLRenderingPipeline';
import {renderFixture} from '../helpers/renderPipeline';
afterEach(() => {vi.restoreAllMocks();});
it('waits for context restoration, rebuilds all GPU state, and removes listeners on dispose', async () => {
  const fixture = renderFixture({backend:'webgl'});vi.mocked(makeWebGLRenderTargets).mockReturnValue(fixture.pipeline);
  const canvas = Object.assign(new EventTarget(), {width:128,height:96}) as HTMLCanvasElement;
  const engine = new Engine({canvas,backend:'webgl'});engine.scene = fixture.scene;engine.camera = fixture.camera;engine.update();await engine.init();
  const render = new Render(engine,{maxSamples:1,denoiser:{type:'jnlm'}});render.refine();const event = vi.fn();engine.on('devicelost', event);
  const lost = new Event('webglcontextlost',{cancelable:true});canvas.dispatchEvent(lost);
  expect(lost.defaultPrevented).toBe(true);expect(event).toHaveBeenCalledWith({reason:'webglcontextlost',recovering:true});expect(render.status).toBe('preparing');expect(render.samples).toBe(0);
  render.refine();await Promise.resolve();expect(makeWebGLRenderTargets).toHaveBeenCalledOnce();expect(render.status).toBe('preparing');
  canvas.dispatchEvent(new Event('webglcontextrestored'));await engine.init();render.refine();expect(makeWebGLRenderTargets).toHaveBeenCalledTimes(2);expect(render.samples).toBe(1);
  engine.dispose();canvas.dispatchEvent(new Event('webglcontextlost'));expect(event).toHaveBeenCalledOnce();fixture.engine.dispose();
});
it('rejects pending restoration when the engine is disposed', async () => {
  const fixture=renderFixture({backend:'webgl'});vi.mocked(makeWebGLRenderTargets).mockReturnValue(fixture.pipeline);
  const canvas=Object.assign(new EventTarget(),{width:1,height:1}) as HTMLCanvasElement;const engine=new Engine({canvas,backend:'webgl'});await engine.init();
  canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));const waiting=engine.init();engine.dispose();await expect(waiting).rejects.toThrow('disposed');fixture.engine.dispose();
});
