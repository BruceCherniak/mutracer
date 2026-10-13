import {Engine} from '../../src/main.js';import {captureOffscreen} from './offscreenCapture.js';
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<any>) => void;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = async ({data}: MessageEvent<{canvas:OffscreenCanvas; webgl:boolean; fallback:boolean; textureMode?:'canvas'|'bitmap'}>) => {
  const worker = globalThis.Worker;let created=0,completed=0;
  globalThis.Worker = class extends worker {
    constructor(url: string | URL, options?: WorkerOptions) {
      if(data.fallback) throw new Error('Forced nested Worker startup failure');
      super(url,options);created++;this.addEventListener('message',()=>completed++);
    }
  };
  // Exercise RenderLoop's timer fallback even in workers that provide rAF.
  Object.defineProperty(globalThis,'requestAnimationFrame',{value:undefined,configurable:true});
  const defaultEngine = new Engine();const defaultOffscreen = defaultEngine.display.canvas instanceof OffscreenCanvas;defaultEngine.dispose();
  const engine=new Engine({canvas:data.canvas,backend:data.webgl?'webgl':'webgpu'});
  try {const result=await captureOffscreen(engine,data.textureMode);scope.postMessage({...result,defaultOffscreen,nested:{created,completed},pixels:result.pixels},[result.pixels.buffer]);}
  catch(error) {scope.postMessage({error:String(error),stack:(error as Error).stack});}
  finally {engine.dispose();globalThis.Worker=worker;}
};
