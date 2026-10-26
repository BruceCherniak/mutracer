import {expect,it,vi} from 'vitest';
import {WebGLDevice,WebGLProgramBindings,FragmentShader} from '../../src/renderer/webgl';
it('reports actual completed WebGL program fractions and source measurements',()=>{
 const complete=new Set<object>();const extension={COMPLETION_STATUS_KHR:100};
 const gl={VERTEX_SHADER:1,FRAGMENT_SHADER:2,COMPILE_STATUS:3,LINK_STATUS:4,
  getExtension:(name:string)=>name==='KHR_parallel_shader_compile'?extension:null,
  createProgram:()=>({}),createShader:()=>({}),shaderSource(){},compileShader(){},getShaderParameter:vi.fn(()=>true),attachShader(){},deleteShader(){},linkProgram(){},viewport(){},
  getProgramParameter:vi.fn((program:object,key:number)=>{if(key===extension.COMPLETION_STATUS_KHR)return complete.has(program);if(!complete.has(program))throw new Error('blocking status query before completion');return true;})};
 const renderer=new WebGLDevice({canvas:{width:1,height:1,getContext:()=>gl} as unknown as HTMLCanvasElement,parallelShaderCompile:true});
 const shader=new FragmentShader({name:'progress test',outputs:['color'],main:'void main(){out_color=vec4(1.0);}'});
 shader.parallelCompile=true;
 const first=renderer.createProgram(shader,{});renderer.createProgram(shader,{});
 let diag=renderer.getShaderCompilationDiagnostics();expect(diag.pipelineCount).toBe(2);expect(diag.completedPipelineCount).toBe(0);expect(diag.sourceBytes).toBeGreaterThan(0);expect(diag.modules).toHaveLength(2);
 expect(gl.getShaderParameter).not.toHaveBeenCalled();
 complete.add(first);diag=renderer.getShaderCompilationDiagnostics();expect(diag.completedPipelineCount/diag.pipelineCount).toBe(.5);expect(diag.status).toBe('compiling');
 expect(renderer.isAllProgramCompiled()).toBe(false);
});

it('defers program use and reports a failed asynchronous link before drawing',()=>{
 const complete=new Set<object>(),extension={COMPLETION_STATUS_KHR:100};
 const gl={VERTEX_SHADER:1,FRAGMENT_SHADER:2,COMPILE_STATUS:3,LINK_STATUS:4,
  getExtension:()=>extension,createProgram:()=>({}),createShader:()=>({}),shaderSource(){},compileShader(){},attachShader(){},deleteShader:vi.fn(),linkProgram(){},viewport(){},
  getProgramParameter:(program:object,key:number)=>key===extension.COMPLETION_STATUS_KHR?complete.has(program):false,
  getShaderParameter:()=>false,getShaderInfoLog:()=> 'invalid fixture shader',getShaderSource:()=> 'fixture source',getProgramInfoLog:()=> 'fixture link error',useProgram:vi.fn()};
 const renderer=new WebGLDevice({canvas:{width:1,height:1,getContext:()=>gl} as unknown as HTMLCanvasElement,parallelShaderCompile:true});
 const shader=new FragmentShader({name:'async failure',main:'void main(){}'});shader.parallelCompile=true;
 const bindings=new WebGLProgramBindings(shader),program=bindings.getProgram(renderer);
 expect(bindings.bind(renderer)).toBe(false);expect(gl.useProgram).not.toHaveBeenCalled();
 complete.add(program);
 expect(()=>bindings.bind(renderer)).toThrow('invalid fixture shader');
 expect(()=>bindings.bind(renderer)).toThrow('fixture link error');
 expect(gl.useProgram).not.toHaveBeenCalled();expect(gl.deleteShader).toHaveBeenCalledTimes(2);
});
