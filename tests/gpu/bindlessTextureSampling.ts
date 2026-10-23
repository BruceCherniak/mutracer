import type Texture from '../../src/scene/Texture.js';
import {isTextureDataSource} from '../../src/scene/Texture.js';
import Material from '../../src/scene/OpenPBRMaterial.js';
import MaterialTable from '../../src/renderer/MaterialTable.js';
import {createMaterialBufferWgsl} from '../../src/renderer/wgsl/chunks/materialBuffer.wgsl.js';
import {WGPUBindlessTextures} from '../../src/renderer/WGPUBindlessTextures.js';
import {bindlessShaderSource} from '../../src/renderer/wgpuBindlessSource.js';
import {resourceTableFeature, setResourceTable} from '../../src/renderer/wgpuBindless.js';
import {constants} from '../../src/renderer/webgl.js';

/** Isolate filter precision from path changes caused by perturbed normals/rays. */
export async function compareBindlessSampling(device: GPUDevice, textures: Texture[]) {
  const support=resourceTableFeature(device.features);if(!support) return undefined;
  const table=new MaterialTable(textures.map(map=>new Material({map})),[]);
  const maps=table.texture!, floatStorage=maps.storageType===constants.HALF_FLOAT;
  const gpu=device.createTexture({format:floatStorage?'rgba16float':'rgba8unorm',size:[maps.width,maps.height,Math.max(2,maps.source!.length)],usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  const independent=new WGPUBindlessTextures(device), allocated:GPUBuffer[]=[];
  try {
    maps.source!.forEach((image: HTMLCanvasElement, layer: number)=>{
      if(isTextureDataSource(image)) device.queue.writeTexture({texture:gpu,origin:[0,0,layer]},image.data,{bytesPerRow:image.width*(floatStorage?8:4)},[image.width,image.height]);
      else device.queue.copyExternalImageToTexture({source:image as HTMLCanvasElement},{texture:gpu,origin:[0,0,layer]},[maps.width,maps.height]);
    });
    independent.update(textures,384*1024*1024);
    const count=Math.max(20,Math.ceil(textures.length/10)*10), metadata=new Float32Array(count*12);
    const data=table.bufferData;
    metadata.set(data.mapInfo);metadata.set(data.mapTransform,count*4);
    textures.forEach((_,i)=>metadata.set([data.mapUvChannel[i],data.mapColorLinear[i],...data.mapWrap.slice(i*2,i*2+2)],count*8+i*4));
    const info=device.createBuffer({size:metadata.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});allocated.push(info);device.queue.writeBuffer(info,0,metadata);
    const helpers=createMaterialBufferWgsl();
    const code=`const NUM_MAPS=${count};
@group(1) @binding(0) var mapSampler: sampler;
@group(1) @binding(1) var map: texture_2d_array<f32>;
@group(1) @binding(3) var<uniform> mapInfo: array<vec4f, NUM_MAPS * 3>;
${helpers.slice(helpers.indexOf('fn sRGBToLinear('),helpers.indexOf('fn getMaterialEmission('))}
fn getMaterialEmission() -> f32 {return 0.0;}
@group(3) @binding(0) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=${textures.length*257}u){return;}
 let index=i32(id.x%${textures.length}u);let c=id.x/${textures.length}u;
 let uv=vec2f(f32(c%17u)/8.0-0.5,f32(c/17u)/7.0-0.5);
 output[id.x]=sampleMap(index,uv);
}`;
    const arrays:Float32Array[]=[];
    for(const bindless of [false,true]) {
      const module=device.createShaderModule({code:bindless?bindlessShaderSource(code,support.enable):code});
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module}});
      const bytes=textures.length*257*16;
      const out=device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const read=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});allocated.push(out,read);
      const inputs=device.createBindGroup({layout:pipeline.getBindGroupLayout(bindless?0:1),entries:bindless?
        [{binding:7,resource:{buffer:independent.metadata!}}]:
        [{binding:0,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},{binding:1,resource:gpu.createView()},{binding:3,resource:{buffer:info}}]});
      const outputs=device.createBindGroup({layout:pipeline.getBindGroupLayout(bindless?2:3),entries:[{binding:0,resource:{buffer:out}}]});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
      pass.setPipeline(pipeline);if(bindless)setResourceTable(pass,independent.table!);
      pass.setBindGroup(bindless?0:1,inputs);pass.setBindGroup(bindless?2:3,outputs);pass.dispatchWorkgroups(Math.ceil(textures.length*257/64));pass.end();
      encoder.copyBufferToBuffer(out,0,read,0,bytes);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      arrays.push(new Float32Array(read.getMappedRange()).slice());read.unmap();
    }
    let max=0, normalizedMax=0, squared=0;
    const ranges=textures.map(t=>{const image=t.image;return isTextureDataSource(image)&&image.data instanceof Float32Array?image.data.reduce((m,x)=>Math.max(m,Math.abs(x)),1):1;});
    for(let i=0;i<arrays[0].length;i++) {
      const delta=Math.abs(arrays[0][i]-arrays[1][i]);
      if(!Number.isFinite(delta))throw new Error('Non-finite isolated texture sample');
      max=Math.max(max,delta);squared+=delta*delta;normalizedMax=Math.max(normalizedMax,delta/ranges[Math.floor(i/4)%textures.length]);
    }
    // Linear filter weights have finite subtexel precision. Changing atlas
    // normalization can change each axis by one 1/256 weight step.
    if(normalizedMax>2/256+1e-6)throw new Error('Texture samples exceed linear-filter precision bound: '+normalizedMax);
    return {max,normalizedMax,rmse:Math.sqrt(squared/arrays[0].length),samples:arrays[0].length/4,bound:2/256};
  } finally {independent.dispose();gpu.destroy();allocated.forEach(b=>b.destroy());}
}
