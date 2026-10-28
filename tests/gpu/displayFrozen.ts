import{initUNetFromBuffer}from'/node_modules/oidn-webgpu/dist/oidn.js';
import{composeDefine,createComposeMain,compositeDenoiseOutputMain,createCompositeDenoiseDisplayMain}from'/src/renderer/wgsl/compose.frag.wgsl.ts';
const root=new URLSearchParams(location.search).get('input');
const save=(name,body)=>fetch('/evidence/frozen-'+name,{method:'POST',body});
async function run(){
 const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU');const device=await adapter.requestDevice({requiredFeatures:adapter.features.has('shader-f16')?['shader-f16']:[]});
 const size=[827,767],bytes=size[0]*size[1]*16;
 const images=await Promise.all(['hdr','albedo','normal'].map(async n=>new Float32Array(await(await fetch(root+'/'+n+'.f32')).arrayBuffer())));
 const upload=v=>{const b=device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});device.queue.writeBuffer(b,0,v);return b;};
 const raw=upload(images[0]),albedo=upload(images[1]),normal=upload(Float32Array.from(images[2],(x,i)=>i%4<3?x*.5+.5:x)),linear=upload(new Float32Array(images[0].length)),encoded=upload(new Float32Array(images[0].length)),guide=upload(new Float32Array(images[0].length));
 const read=async b=>{const t=device.createBuffer({size:bytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});const e=device.createCommandEncoder();e.copyBufferToBuffer(b,0,t,0,bytes);device.queue.submit([e.finish()]);await t.mapAsync(GPUMapMode.READ);const a=new Float32Array(t.getMappedRange().slice(0));t.unmap();t.destroy();return a;};

 const prefix=`var<private> toneMappingParams:vec4f;var<private> colorGradingParams:vec4f;${composeDefine}
fn indexOf(p:vec2i)->u32{return u32(p.y)*827u+u32(p.x);}
fn colorTexRegion()->vec2u{return vec2u(827,767);}
fn load_colorTex(p:vec2i,l:i32)->vec4f{return inputColor[indexOf(p)];}
fn load_bloomTex(p:vec2i,l:i32)->vec4f{return vec4f(0);}
fn load_flatBackgroundMaskTex(p:vec2i,l:i32)->vec4f{return inputAlbedo[indexOf(p)];}
fn load_shadowCatcherTex(p:vec2i,l:i32)->vec4f{return vec4f(0);}
fn load_foregroundTex(p:vec2i,l:i32)->vec4f{return load_colorTex(p,l);}
fn load_catcherBackgroundTex(p:vec2i,l:i32)->vec4f{return vec4f(0);}
struct Output{color:vec4f,denoiseColor:vec4f,denoiseAlbedo:vec4f}`;
 const code=`@group(0)@binding(0)var<storage,read>inputColor:array<vec4f>;@group(0)@binding(1)var<storage,read_write>outputColor:array<vec4f>;@group(0)@binding(2)var<storage,read>inputAlbedo:array<vec4f>;@group(0)@binding(3)var<storage,read_write>outputEncoded:array<vec4f>;@group(0)@binding(4)var<storage,read_write>outputAlbedo:array<vec4f>;
${prefix}
@compute @workgroup_size(8,8)fn main(@builtin(global_invocation_id)id:vec3u){if(any(id.xy>=vec2u(827,767))){return;}let uv=vec2i(id.xy);toneMappingParams=vec4f(0);colorGradingParams=vec4f(1,1,0,0);let exposure=1.;let bloomIntensity=0.;let hdrOutputEnabled=0.;let flatBackgroundColor=vec4f(0);let shadowCatcherEnabled=0.;let shadowCatcherColor=vec3f(0);let shadowCatcherAlpha=1.;var output:Output;
${createComposeMain()}${compositeDenoiseOutputMain}
let i=id.y*827u+id.x;outputColor[i]=output.denoiseColor;outputEncoded[i]=output.color;outputAlbedo[i]=round(output.denoiseAlbedo*255.)/255.;}`;
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}});
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[raw,linear,albedo,encoded,guide].map((buffer,binding)=>({binding,resource:{buffer}}))});
 const network=await initUNetFromBuffer(await(await fetch('/oidn/weights/rt_hdr_alb_nrm.tza')).arrayBuffer(),{device},{aux:true,hdr:true,hdrTransfer:'pu',precision:'auto',maxTileSize:512,dynamicTile:false});
 let filtered;const actual=[];
 const compose=step=>{const e=device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(pipeline);p.setBindGroup(0,group);p.dispatchWorkgroups(Math.ceil(step.width/8),Math.ceil(step.height/8));p.end();device.queue.submit([e.finish()]);actual.push(step.kind);};
 compose({width:size[0],height:size[1],kind:'Compose:DisplayLinear'});
 await save('input.f32',await read(linear));await save('albedo.f32',await read(guide));await save('normal.f32',await read(normal));
 filtered=await new Promise((resolve,reject)=>network.tileExecute({tileOverlap:80,color:{data:linear,width:size[0],height:size[1]},albedo:{data:guide,width:size[0],height:size[1]},normal:{data:normal,width:size[0],height:size[1]},done:resolve,error:reject}));actual.push('Denoise:DisplayLinear');
 const values=await read(filtered.data);await save('filtered.f32',values);
 const output=upload(new Float32Array(images[0].length));const encodeCode=`@group(0)@binding(0)var<storage,read>color:array<vec4f>;@group(0)@binding(1)var<storage,read>composed:array<vec4f>;@group(0)@binding(2)var<storage,read_write>result:array<vec4f>;var<private> toneMappingParams:vec4f;var<private> colorGradingParams:vec4f;${composeDefine}
fn load_colorTex(p:vec2i,l:i32)->vec4f{return color[u32(p.y)*827u+u32(p.x)];}fn load_composedTex(p:vec2i,l:i32)->vec4f{return composed[u32(p.y)*827u+u32(p.x)];}struct Output{color:vec4f}
@compute @workgroup_size(8,8)fn main(@builtin(global_invocation_id)id:vec3u){if(any(id.xy>=vec2u(827,767))){return;}let uv=vec2i(id.xy);let denoisedAlpha=0.;var output:Output;${createCompositeDenoiseDisplayMain()}result[id.y*827u+id.x]=output.color;}`;
 const encodePipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:encodeCode}),entryPoint:'main'}});
 const encodeGroup=device.createBindGroup({layout:encodePipeline.getBindGroupLayout(0),entries:[filtered.data,linear,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
 {const e=device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(encodePipeline);p.setBindGroup(0,encodeGroup);p.dispatchWorkgroups(Math.ceil(size[0]/8),Math.ceil(size[1]/8));p.end();device.queue.submit([e.finish()]);actual.push('Encode:DisplayEncoded');}
 const final=await read(output);await save('display.f32',final);const rgba=Uint8ClampedArray.from(final,x=>Math.round(Math.min(1,Math.max(0,x))*255));
 const canvas=document.createElement('canvas');canvas.width=size[0];canvas.height=size[1];canvas.getContext('2d').putImageData(new ImageData(rgba,...size),0,0);await save('display.png',await new Promise(resolve=>canvas.toBlob(resolve)));
 let bright=0;for(let i=0;i<rgba.length;i+=4){const x=(i/4)%827-644,y=Math.floor(i/4/827)-463;if(x*x+y*y>4&&x*x+y*y<3600&&rgba[i]>=240&&rgba[i+1]>=240&&rgba[i+2]>=240)bright++;}
 const result={passed:values.every(Number.isFinite)&&bright===0,size,adapter:adapter.info,precision:'auto',tile:512,model:'standard',brightNeighbourhoodPixels:bright,records:actual,expected:['Compose:DisplayLinear','Denoise:DisplayLinear','Encode:DisplayEncoded']};
 await save('result.json',JSON.stringify(result));network.dispose();device.destroy();return result;
}
document.querySelector('#run').onclick=()=>{document.querySelector('#result').textContent='Running';run().then(r=>document.querySelector('#result').textContent=JSON.stringify(r)).catch(async e=>{const r={passed:false,error:String(e.stack??e)};document.querySelector('#result').textContent=JSON.stringify(r);await save('error.json',JSON.stringify(r));});};

window.runBenchmark=run;
