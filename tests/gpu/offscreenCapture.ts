import {Engine, Render, RenderLoop, Texture, OpenPBRMaterial} from '../../src/main.js';
import {setBasicScene} from './hostScene.js';
export async function captureOffscreen(engine: Engine, textureMode?: 'canvas' | 'bitmap') {
  setBasicScene(engine);
  if (textureMode) {
    const image = new OffscreenCanvas(8,8), context = image.getContext('2d')!;
    context.fillStyle = '#d08040';context.fillRect(0,0,8,8);context.fillStyle = '#4080d0';context.fillRect(0,0,4,4);
    const source = textureMode==='bitmap' ? await createImageBitmap(image) : image;
    engine.scene!.meshes[0].materials[0] = new OpenPBRMaterial({map:new Texture(source), specularRoughness:.6});engine.update();
    if ('close' in source) source.close(); // committed snapshot must own its pixels
  }
  const render = new Render(engine,{bounces:6,maxSamples:2,denoiser:{type:'jnlm'}});
  const loop = new RenderLoop(engine,{preview:false,final:render});loop.start();
  for(let attempts=0;attempts<3000 && loop.status!=='finished';attempts++) {
    if(loop.status==='error') throw engine.lastError;await new Promise(resolve=>setTimeout(resolve,2));
  }
  loop.stop();if(loop.status!=='finished') throw new Error('Worker loop timed out');
  await render.converge({samples:64,sampleSequenceOffset:0});engine.display.present(render);
  const pixels=await render.readPixels('hdr');const blob=await engine.display.toBlob(render);
  const bitmap=await createImageBitmap(blob);const blobSize=[bitmap.width,bitmap.height];bitmap.close();
  const result={pixels:pixels.data,blobBytes:blob.size,blobType:blob.type,blobSize,loopStatus:loop.status,info:engine.info,diagnostics:engine.getDiagnostics()};
  loop.dispose();render.dispose();return result;
}
