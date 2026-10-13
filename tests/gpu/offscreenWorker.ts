import {Engine} from '../../src/main.js';import {captureOffscreen} from './offscreenCapture.js';
const query=new URLSearchParams(location.search);
(window as any).captureWorker = async (textureMode?:'canvas'|'bitmap') => {
  const webgl=query.has('webgl'),fallback=query.has('fallback');
  const main=new Engine({canvas:document.getElementById('main') as HTMLCanvasElement,backend:webgl?'webgl':'webgpu'});
  const worker=new Worker(new URL('./offscreenWorker.worker.ts',import.meta.url),{type:'module'});
  try {
    const reference=await captureOffscreen(main,textureMode);
    const output=await new Promise<any>((resolve,reject)=> {
      worker.onmessage=({data})=>data.error?reject(new Error(data.error+'\n'+data.stack)):resolve(data);
      worker.onerror=event=>reject(new Error(event.message));
      const canvas=(document.getElementById('worker') as HTMLCanvasElement).transferControlToOffscreen();worker.postMessage({canvas,webgl,fallback,textureMode},[canvas]);
    });
    const result={main:{...reference,pixels:Array.from(reference.pixels)},worker:{...output,pixels:Array.from(output.pixels)}};
    document.getElementById('result')!.textContent=JSON.stringify({...result,main:{...result.main,pixels:undefined},worker:{...result.worker,pixels:undefined}},null,2);return result;
  } finally {main.dispose();worker.terminate();}
};
