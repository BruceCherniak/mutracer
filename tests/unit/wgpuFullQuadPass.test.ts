import {expect,it,vi,afterEach} from 'vitest';
import {WGPUFullQuadPass} from '../../src/renderer/WGPUFullQuadPass';
afterEach(()=>{vi.unstubAllGlobals();});
it('keeps initial pipeline creation and resized outputs pending when formats are unchanged',()=>{
 vi.stubGlobal('GPUBufferUsage',{UNIFORM:1,COPY_DST:2});vi.stubGlobal('GPUTextureUsage',{RENDER_ATTACHMENT:1,TEXTURE_BINDING:2,COPY_SRC:4});
 const createRenderPipeline=vi.fn(()=>({getBindGroupLayout:()=>({})}));
 const device={createBuffer:()=>({}),queue:{writeBuffer(){}},createShaderModule:()=>({}),createRenderPipeline,createBindGroup:()=>({}),createTexture:(options:any)=>({...options.size,createView:()=>({}),destroy(){}})} as unknown as GPUDevice;
 const pass=new WGPUFullQuadPass('readback',device,{inputs:['input'],outputs:['color'],fsMain:'output.color=load_input(uv,0);'});
 const input={createView:()=>({})} as GPUTexture;
 const encoder={beginRenderPass:()=>({setViewport(){},setScissorRect(){},setPipeline(){},setBindGroup(){},draw(){},end(){}})} as unknown as GPUCommandEncoder;
 pass.setOutputParams({color:{format:'rgba32float'}});pass.setSize(64,64);pass.setOutputParams({color:{format:'rgba32float'}});pass.createPass(encoder,{input});
 expect(createRenderPipeline).toHaveBeenCalledOnce();expect(pass.getOutput('color').width).toBe(64);
 pass.setSize(128,64);pass.setOutputParams({color:{format:'rgba32float'}});pass.createPass(encoder,{input});
 expect(pass.getOutput('color').width).toBe(128);
});
it('reselects attachment pipelines when a shared output moves between HDR, offscreen and SDR targets',()=>{
 vi.stubGlobal('GPUBufferUsage',{UNIFORM:1,COPY_DST:2});vi.stubGlobal('GPUTextureUsage',{RENDER_ATTACHMENT:1,TEXTURE_BINDING:2,COPY_SRC:4});
 const texture=(format:GPUTextureFormat)=>({width:64,height:64,format,createView:()=>({format}),destroy(){}} as unknown as GPUTexture);
 const device={createBuffer:()=>({}),queue:{writeBuffer(){}},createShaderModule:()=>({}),createRenderPipeline:(options:GPURenderPipelineDescriptor)=>({format:Array.from(options.fragment!.targets)[0]!.format,getBindGroupLayout:()=>({})}),createBindGroup:()=>({}),createTexture:(options:GPUTextureDescriptor)=>texture(options.format)} as unknown as GPUDevice;
 const pass=new WGPUFullQuadPass('shared output',device,{inputs:['input'],outputs:['color'],fsMain:'output.color=load_input(uv,0);'});
 const input=texture('rgba8unorm');
 const encoder={beginRenderPass:(options:any)=>({setViewport(){},setScissorRect(){},setPipeline(pipeline:any){expect(pipeline.format).toBe(options.colorAttachments[0].view.format);},setBindGroup(){},draw(){},end(){}})} as unknown as GPUCommandEncoder;
 pass.setOutputParams({color:{format:'rgba8unorm'}});pass.setSize(64,64);
 pass.setRenderToScreen(texture('rgba16float'),'rgba16float');pass.createPass(encoder,{input});
 // A new target configures this shared pass with the same offscreen format.
 pass.setOutputParams({color:{format:'rgba8unorm'}});
 pass.setRenderToScreen(texture('bgra8unorm'),'bgra8unorm');pass.createPass(encoder,{input});
 pass.setOutputParams({color:{format:'rgba8unorm'}});pass.createPass(encoder,{input});
 pass.setRenderToScreen(texture('rgba16float'),'rgba16float');pass.createPass(encoder,{input});
});
