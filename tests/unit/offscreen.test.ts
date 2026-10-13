import {afterEach, expect, it, vi} from 'vitest';
import Engine from '../../src/Engine';import Render from '../../src/Render';import RenderLoop from '../../src/RenderLoop';
import Texture from '../../src/scene/Texture';import Mesh from '../../src/scene/Mesh';import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createCubeGeometry} from '../../src/util/commonGeometry';import {renderFixture} from '../helpers/renderPipeline';
const canvases: Canvas[] = [];
class Canvas {
  context = {drawImage: vi.fn(), putImageData: vi.fn()};
  constructor(public width: number, public height: number) {canvases.push(this);}
  getContext() {return this.context;}
  convertToBlob = vi.fn(async () => new Blob(['encoded'], {type:'image/png'}));
}
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('constructs a default OffscreenCanvas engine without document', () => {
  vi.stubGlobal('document', undefined);vi.stubGlobal('OffscreenCanvas', Canvas);
  const engine = new Engine();expect(engine.display.canvas).toBeInstanceOf(Canvas);expect([engine.display.canvas.width,engine.display.canvas.height]).toEqual([300,150]);engine.dispose();
});
it('runs and cancels timer frames when neither document nor requestAnimationFrame exists', () => {
  vi.useFakeTimers();vi.stubGlobal('document', undefined);vi.stubGlobal('requestAnimationFrame', undefined);
  const {engine} = renderFixture();const loop = new RenderLoop(engine, {preview:false,final:{maxSamples:3}});
  loop.start();loop.start();expect(vi.getTimerCount()).toBe(1);vi.advanceTimersByTime(16);expect(loop.final.samples).toBe(1);expect(vi.getTimerCount()).toBe(1);
  loop.stop();expect(vi.getTimerCount()).toBe(0);vi.advanceTimersByTime(100);expect(loop.final.samples).toBe(1);
  loop.start();vi.advanceTimersByTime(16);expect(loop.final.samples).toBe(2);loop.dispose();expect(vi.getTimerCount()).toBe(0);engine.dispose();
});
it('encodes OffscreenCanvas output with convertToBlob and retains encoder options', async () => {
  vi.stubGlobal('document', undefined);vi.stubGlobal('OffscreenCanvas', Canvas);
  vi.stubGlobal('ImageData', class {constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}});
  const {engine} = renderFixture();const render = new Render(engine,{width:16,height:16});render.refine();
  const encode = vi.spyOn(Canvas.prototype, 'getContext');const result = await engine.display.toBlob(render,{type:'image/png',quality:.8});
  expect(result.type).toBe('image/png');expect(encode).toHaveBeenCalledWith('2d');expect(canvases.at(-1)!.convertToBlob).toHaveBeenCalledWith({type:'image/png',quality:.8});engine.dispose();
});
it.each(['canvas','bitmap'])('snapshots %s pixels at update without document', kind => {
  vi.stubGlobal('document', undefined);vi.stubGlobal('OffscreenCanvas', Canvas);
  class Bitmap {width=2;height=2;}vi.stubGlobal('ImageBitmap', Bitmap);
  const {engine,pipeline} = renderFixture();const source = kind==='canvas'?new Canvas(2,2):new Bitmap();
  const texture = new Texture(source as unknown as OffscreenCanvas);const material = new OpenPBRMaterial({map:texture});engine.scene={meshes:[new Mesh(createCubeGeometry(),material)],lights:[]};engine.update();
  const uploaded = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0][0].materials[0].map!.image as unknown as Canvas;
  expect(uploaded).not.toBe(source);expect(uploaded.context.drawImage).toHaveBeenCalledWith(source,0,0);texture.markUpdated();engine.update();
  expect(uploaded.context.drawImage).toHaveBeenCalledTimes(2);engine.dispose();
});
