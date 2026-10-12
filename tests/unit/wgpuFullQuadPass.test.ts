import {expect,it,vi,afterEach} from 'vitest';
import {WGPUFullQuadPass} from '../../src/renderer/WGPUFullQuadPass';
afterEach(()=>{vi.unstubAllGlobals();});
it('keeps initial pipeline creation and resized outputs pending when formats are unchanged',()=>{
 vi.stubGlobal('GPUBufferUsage',{UNIFORM:1,COPY_DST:2});vi.stubGlobal('GPUTextureUsage',{RENDER_ATTACHMENT:1,TEXTURE_BINDING:2,COPY_SRC:4});
 const createRenderPipeline=vi.fn(()=>({getBindGroupLayout:()=>({})}));
 const device={createBuffer:()=>({}),queue:{writeBuffer(){}},createShaderModule:()=>({}),createRenderPipeline,createBindGroup:()=>({}),createTexture:(options:any)=>({...options.size,createView:()=>({}),destroy(){}})} as unknown as GPUDevice;
 const pass=new WGPUFullQuadPass('readback',device,{inputs:['input'],outputs:['color'],fsMain:'output.color=textureLoad(input,uv,0);'});
 const input={createView:()=>({})} as GPUTexture;
 const encoder={beginRenderPass:()=>({setPipeline(){},setBindGroup(){},draw(){},end(){}})} as unknown as GPUCommandEncoder;
 pass.setOutputParams({color:{format:'rgba32float'}});pass.setSize(64,64);pass.setOutputParams({color:{format:'rgba32float'}});pass.createPass(encoder,{input});
 expect(createRenderPipeline).toHaveBeenCalledOnce();expect(pass.getOutput('color').width).toBe(64);
 pass.setSize(128,64);pass.setOutputParams({color:{format:'rgba32float'}});pass.createPass(encoder,{input});
 expect(pass.getOutput('color').width).toBe(128);
});
