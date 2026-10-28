import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {serve,ready,root} from './reference-capture.mjs';
import {launchChrome} from './reference-runtime.mjs';
const input=process.env.MUTRACER_OIDN_DISPLAY_INPUT;if(!input)throw Error('Set MUTRACER_OIDN_DISPLAY_INPUT');
const out=resolve(process.env.MUTRACER_PARITY_OUTPUT);mkdirSync(out,{recursive:true});
const server=await serve(root,out,resolve(root,'tests/gpu/displayFrozen.js'));let chrome;
try{
 chrome=await launchChrome();const page=await chrome.page(server.url+'?input='+encodeURIComponent('/@fs/'+input));
 try{
  await ready(page.tab);
  const result=process.argv.includes('--compare-only')?JSON.parse(readFileSync(resolve(out,'browser-result.json'))):await page.tab.evaluate('window.runBenchmark()');
  writeFileSync(resolve(out,'browser-result.json'),JSON.stringify(result,null,2));
  const native=process.env.MUTRACER_NATIVE_DISPLAY_PNG;
  if(native){
   const urls=[native,resolve(out,'frozen-display.png')].map(path=>'/@fs/'+path);
   const comparison=await page.tab.evaluate(`(async()=>{
    const images=await Promise.all(${JSON.stringify(urls)}.map(async url=>{
     const bitmap=await createImageBitmap(await(await fetch(url)).blob());
     const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
     const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);return ctx.getImageData(0,0,bitmap.width,bitmap.height);
    }));
    if(images[0].width!==images[1].width||images[0].height!==images[1].height)throw Error('Frozen image sizes differ');
    let maximum=0,alpha=true;const bright=[0,0];
    for(let i=0;i<images[0].data.length;i++){
     maximum=Math.max(maximum,Math.abs(images[0].data[i]-images[1].data[i]));
     if(i%4===3)alpha&&=images[0].data[i]===images[1].data[i];
     if(i%4===0){const x=(i/4)%827-644,y=Math.floor(i/4/827)-463;
      if(x*x+y*y>4&&x*x+y*y<3600)images.forEach((im,j)=>{if(im.data[i]>=240&&im.data[i+1]>=240&&im.data[i+2]>=240)bright[j]++;});}
    }
    return{maximumCodeDifference:maximum,alphaIdentical:alpha,brightNeighbourhoodPixels:bright,passed:maximum<=2&&alpha&&bright.every(n=>n===0)};
   })()`);
   writeFileSync(resolve(out,'comparison.json'),JSON.stringify({native,...comparison},null,2));console.log(comparison);
   if(!comparison.passed)process.exitCode=1;
  }
  console.log(result);if(!result.passed)process.exitCode=1;
 }finally{await page.close();}
}finally{await chrome?.close();await server.close();}
