// Same procedural accumulation on each real GPU backend; production display passes.
import {WGPUFullQuadPass} from '/src/renderer/WGPUFullQuadPass.ts';
import {composeDefine, composeMain, compositeDenoiseOutputMain, compositeDenoiseDisplayMain, linearToSrgbDefine} from '/src/renderer/wgsl/compose.frag.wgsl.ts';
import {WGPUJNLMDenoisePass} from '/src/renderer/WGPUJNLMDenoiser.ts';
import WGPUBloomPass from '/src/renderer/WGPUBloomPass.ts';
import {WebGLDevice, Texture2D, FrameBuffer, constants} from '/src/renderer/webgl.ts';
import {WebGLFullQuadPass} from '/src/renderer/WebGLFullQuadPass.ts';
import {composeFragment} from '/src/renderer/glsl/webglPipeline.frag.ts';
import {WebGLJNLMDenoisePass} from '/src/renderer/WebGLJNLMDenoiser.ts';
import WebGLBloomPass from '/src/renderer/WebGLBloomPass.ts';
import {JNLM_DEFAULT_SHAPE} from '/src/renderer/jnlm.ts';
import table from '/tests/fixtures/display-order.json';
const size=16, count=size*size, samples=32;
const backend=new URLSearchParams(location.search).has('webgl')?'webgl':'webgpu';
const save=(name,body)=>fetch('/evidence/'+backend+'-'+name,{method:'POST',body});
// A deterministic 32-sample image with bounded noise and a broad bright region.
const colors=Float32Array.from({length:count*4},(_,i)=>i%4===3?1:
  (i/4%size<8?2:6)*[1,.5,.25][i%4]+((Math.floor(i/4)*1664525+19)>>>0)%13*.002);
const repeat=v=>Float32Array.from({length:count*4},(_,i)=>v[i%4]);
const albedos=repeat([.3,.4,.5,1]), normals=repeat([.5,.5,1,1]), zeros=repeat([0,0,0,0]);
const moments=new Float32Array(count*12);
for(let i=0;i<count;i++){const p=colors.subarray(i*4,i*4+4),l=p[0]*.2126+p[1]*.7152+p[2]*.0722;moments.set([l*samples,(l*l+10)*samples,0,0],i*12+8);}
let trace=[];
const records=[];
const observe=(object,method,record)=>{const original=object[method].bind(object);object[method]=(...args)=>{trace.push(...record());return original(...args);};};
const settings=row=>({exposure:row.exposure??1,toneMappingParams:[row.tone??0,0],colorGradingParams:[1,1,0,0],
 hdrOutputEnabled:+row.hdr,flatBackgroundColor:[0,0,0,0],shadowCatcherColor:[0,0,0],shadowCatcherAlpha:1,
 shadowCatcherEnabled:0,bloomIntensity:row.bloom?.2:0});
async function webgpu(){
 const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice({requiredLimits:{maxColorAttachmentBytesPerSample:40}});const errors=[];
 device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const texture=data=>{const t=device.createTexture({size:[size,size],format:'rgba32float',usage:GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});device.queue.writeTexture({texture:t},data,{bytesPerRow:size*16},[size,size]);return t;};
 const buffer=data=>{const b=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});device.queue.writeBuffer(b,0,data);return b;};
 const color=texture(colors),albedo=texture(albedos),normal=texture(normals),zero=texture(zeros);
 const acc=buffer(moments),nrm=buffer(repeat([0,0,samples,samples]));
 const pass=new WGPUFullQuadPass('compose',device,{textureWillBeRead:true,inputs:['colorTex','foregroundTex','catcherBackgroundTex','flatBackgroundMaskTex','shadowCatcherTex','bloomTex'],outputs:['color','denoiseColor','denoiseAlbedo'],fsDefine:composeDefine,fsMain:composeMain+compositeDenoiseOutputMain,
 uniforms:Object.entries(settings({})).map(([label,data])=>({label,data,type:Array.isArray(data)?'vec'+data.length+'f':'f32'}))});
 pass.setSize(size,size);
 const encode=new WGPUFullQuadPass('filtered display',device,{textureWillBeRead:true,inputs:['colorTex','composedTex'],outputs:['color'],fsDefine:linearToSrgbDefine,fsMain:compositeDenoiseDisplayMain,uniforms:[{label:'hdrOutputEnabled',type:'f32',data:0},{label:'denoisedAlpha',type:'f32',data:0}]});encode.setSize(size,size);
 const read=async(t)=>{const b=device.createBuffer({size:count*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});const e=device.createCommandEncoder();e.copyTextureToBuffer({texture:t},{buffer:b,bytesPerRow:size*16},[size,size]);device.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);const f=new Float32Array(b.getMappedRange().slice(0));b.unmap();b.destroy();return f;};
 const bloom=new WGPUBloomPass(device);bloom.setSize(size,size);bloom.setBrightThreshold(1);bloom.setRadius(.6);
 const jnlm=new WGPUJNLMDenoisePass(device);
 let active;
 observe(pass,'createPass',()=>['Compose:'+(active.filter==='jnlm'&&active.output===0?'DisplayLinear':'DisplayEncoded')]);
 observe(bloom,'createPass',()=>['Bloom:SceneLinear']);
 observe(jnlm,'encode',()=>['Denoise:DisplayLinear']);
 observe(encode,'createPass',()=>['Encode:DisplayEncoded']);
 for(const row of table.cases){
  active=row;trace=[];
  pass.setOutputParams({color:{format:'rgba32float'},denoiseColor:{format:'rgba32float'},denoiseAlbedo:{format:'rgba8unorm'}});for(const [key,value] of Object.entries(settings(row)))pass.setUniform(key,value);
  const e=device.createCommandEncoder();if(row.bloom)bloom.createPass(e,color);
  pass.createPass(e,{colorTex:color,foregroundTex:color,catcherBackgroundTex:zero,flatBackgroundMaskTex:albedo,shadowCatcherTex:zero,bloomTex:row.bloom?bloom.getOutput():zero});
  let result=pass.getOutput('color');
  if(row.output){result=row.output===1?normal:albedo;trace=['AOV:Raw'];}
  else if(row.filter==='jnlm'){
   const filtered=jnlm.encode(e,{width:size,height:size,accumulation:acc,normalAccumulation:nrm,color:pass.getOutput('denoiseColor'),albedo,normal,shadowCatcher:zero,strength:3,shape:JNLM_DEFAULT_SHAPE});
   const t=device.createTexture({size:[size,size],format:'rgba32float',usage:GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});e.copyBufferToTexture({buffer:filtered,bytesPerRow:size*16},{texture:t},[size,size]);
   encode.setOutputParams({color:{format:'rgba32float'}});encode.setUniform('hdrOutputEnabled',+row.hdr);encode.createPass(e,{colorTex:t,composedTex:pass.getOutput('denoiseColor')});result=encode.getOutput('color');
  }
  device.queue.submit([e.finish()]);let values=await read(result);
  if(row.hdr)values=values.map((x,i)=>i%4===3?x:x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
  if(row.hdr)trace.push('Decode:DisplayLinear');records.push({name:row.name,trace});
  await save(row.name+(row.hdr?'.f32':'.rgba8'),row.hdr?values:Uint8Array.from(values,x=>Math.round(Math.max(0,Math.min(1,x))*255)));
 }
 await save('trace.json',JSON.stringify(records));
 if(errors.length)throw Error(errors.join('\n'));device.destroy();
}
async function webgl(){
 const renderer=new WebGLDevice({canvas:document.querySelector('canvas'),parallelShaderCompile:false}),gl=renderer.gl;
 const tex=data=>new Texture2D({source:{data,width:size,height:size},type:constants.FLOAT,minFilter:constants.NEAREST,magFilter:constants.NEAREST});
 const color=tex(colors),albedo=tex(albedos),normal=tex(normals),zero=tex(zeros);
 const moment=tex(Float32Array.from({length:count*4},(_,i)=>i%4===0?moments[Math.floor(i/4)*12+8]:i%4===1?moments[Math.floor(i/4)*12+9]:i%4===2?samples:1));
 const pass=new WebGLFullQuadPass('compose',renderer,{shader:composeFragment,outputParams:{color:{type:constants.UNSIGNED_BYTE}}});pass.setSize(size,size);
 const bloom=new WebGLBloomPass(renderer);bloom.setSize(size,size);bloom.setBrightThreshold(1);bloom.setRadius(.6);
 const jnlm=new WebGLJNLMDenoisePass(renderer),fbo=new FrameBuffer();
 observe(pass,'createPass',()=>['Compose:DisplayEncoded']);
 observe(bloom,'createPass',()=>['Bloom:SceneLinear']);
 observe(jnlm,'render',()=>['Decode:DisplayLinear','Denoise:DisplayLinear','Encode:DisplayEncoded']);
 for(const row of table.cases.filter(r=>!r.hdr)){
  trace=[];
  if(row.bloom)bloom.createPass(color);
  pass.setUniforms({exposure:row.exposure??1,bloomIntensity:row.bloom?.2:0,toneMappingMode:row.tone??0,shadowCatcherEnabled:0});
  pass.createPass({colorTex:color,foregroundTex:color,catcherBackgroundTex:zero,shadowCatcherTex:zero,bloomTex:row.bloom?bloom.getOutput():zero});
  let result=pass.getOutput('color');if(row.output){result=row.output===1?normal:albedo;trace=['AOV:Raw'];}
  else if(row.filter==='jnlm')result=jnlm.render({width:size,height:size,moments:moment,color:result,albedo,normal,shadowCatcher:zero,strength:3,shape:JNLM_DEFAULT_SHAPE});
  fbo.bind(renderer,[result]);const bytes=new Uint8Array(count*4);
  if(!result.isByteEncoded){const f=new Float32Array(count*4);gl.readPixels(0,0,size,size,gl.RGBA,gl.FLOAT,f);bytes.set(f.map(x=>Math.round(Math.max(0,Math.min(1,x))*255)));}else gl.readPixels(0,0,size,size,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
  records.push({name:row.name,trace});await save(row.name+'.rgba8',bytes);
 }
 await save('trace.json',JSON.stringify(records));
 if(gl.getError())throw Error('WebGL error');
}
window.runBenchmark=async()=>{await(backend==='webgl'?webgl():webgpu());return{passed:true,backend,cases:table.cases.filter(r=>backend!=='webgl'||!r.hdr).length};};
