import {expect,it} from 'vitest';
import {Renderer,FragmentShader} from '../../src/renderer/webgl';
it('reports actual completed WebGL program fractions and source measurements',()=>{
 const complete=new Set<object>();const extension={COMPLETION_STATUS_KHR:100};
 const gl={VERTEX_SHADER:1,FRAGMENT_SHADER:2,COMPILE_STATUS:3,LINK_STATUS:4,
  getExtension:(name:string)=>name==='KHR_parallel_shader_compile'?extension:null,
  createProgram:()=>({}),createShader:()=>({}),shaderSource(){},compileShader(){},getShaderParameter:()=>true,attachShader(){},deleteShader(){},linkProgram(){},viewport(){},
  getProgramParameter:(program:object,key:number)=>key===extension.COMPLETION_STATUS_KHR?complete.has(program):true};
 const renderer=new Renderer({canvas:{width:1,height:1,getContext:()=>gl} as unknown as HTMLCanvasElement,parallelShaderCompile:true});
 const shader=new FragmentShader({name:'progress test',outputs:['color'],main:'void main(){out_color=vec4(1.0);}'});
 const first=renderer.createProgram(shader,{});renderer.createProgram(shader,{});
 let diag=renderer.getShaderCompilationDiagnostics();expect(diag.pipelineCount).toBe(2);expect(diag.completedPipelineCount).toBe(0);expect(diag.sourceBytes).toBeGreaterThan(0);expect(diag.modules).toHaveLength(2);
 complete.add(first);diag=renderer.getShaderCompilationDiagnostics();expect(diag.completedPipelineCount/diag.pipelineCount).toBe(.5);expect(diag.status).toBe('compiling');
 expect(renderer.isAllProgramCompiled()).toBe(false);
});
