import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import ts from 'typescript';
import {specializeStorageLoops} from '../../native/scripts/storage-lowering.mjs';
import {lowerConcreteAccess} from '../../native/scripts/attribute-lowering.mjs';
import {auditNumericAccess} from '../../native/scripts/numeric-access-audit.mjs';
import {writeRawAtlasPlacement} from '../../src/renderer/textureAtlasPixels.js';

function fixture(source: string, action: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'mutracer-storage-'));
  try {
    // These numeric fixtures need typed arrays, not the DOM or ambient packages.
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',strict:true,lib:['ES2022'],types:[]}}));
    writeFileSync(join(directory, 'entry.ts'), source);
    action(directory);
  } finally { rmSync(directory, {recursive:true, force:true}); }
}
function execute(source: string) {
  const exports: Record<string, (...args:any[])=>any> = {};
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('exports',code)(exports);return exports;
}

describe('checker-driven numeric monomorphization', () => {
  it('preserves closure state, caller scale, branches and arithmetic for each storage', () => {
    const source = `
      function kernel<T extends Uint8Array | Float32Array>(data:T, scale:number) {
        const bytes=17, sourceScale=3;
        if(scale<0) throw new Error('negative scale');
        const out=new Float64Array(data.length);
        for(let i=0;i<data.length;i++) out[i]=data[i]/scale+bytes+sourceScale;
        return out;
      }
      export function run(data:Uint8Array|Float32Array,scale:number) {
        const result=new Float64Array(1);
        function nested<T extends Uint8Array|Float32Array>(input:T) {result[0]=kernel(input,scale)[0];}
        if(data instanceof Uint8Array) nested(data); else nested(data);
        return result;
      }`;
    fixture(source, directory => {
      const summary = specializeStorageLoops(directory, 'entry.ts');
      expect(summary.functions).toBeGreaterThan(0);
      const actual = execute(readFileSync(join(directory, 'entry.ts'),'utf8')), reference=execute(source);
      for(const Type of [Uint8Array,Float32Array]) for(const scale of [.5,7,255]) {
        const input=new Type([63.25]);expect(actual.run(input,scale)).toEqual(reference.run(input,scale));
      }
      expect(()=>actual.run(new Uint8Array([1]),-1)).toThrow('negative scale');
    });
  });
  it('retains reexported imports and module side effects after replacing generic calls', () => {
    fixture(`import {kernel, value} from './helper.js';
      export {value};
      export function run(input:Float32Array) {return kernel(input);}`, directory => {
      writeFileSync(join(directory,'helper.ts'), 'export const value=7; export function kernel<T extends Float32Array|Float64Array>(x:T){return x[0];}');
      specializeStorageLoops(directory,'entry.ts');
      const output=readFileSync(join(directory,'entry.ts'),'utf8');
      expect(output).toContain('value');
      expect(output).toContain('export { value }');
      const program=ts.createProgram([join(directory,'entry.ts')],{noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,noUnusedLocals:true,lib:['lib.es2022.d.ts'],types:[]});
      expect(ts.getPreEmitDiagnostics(program).filter(d=>d.file?.fileName.startsWith(directory))).toEqual([]);
    });
  });
  it('fails builds for direct and indirectly repeated storage dispatch', () => {
    fixture(`import {read} from './src/math/access.js';
      function value(data:Float32Array|Float64Array,i:number){return read(data,i);}
      export function run(data:Float32Array|Float64Array){let sum=0;for(let i=0;i<data.length;i++)sum+=value(data,i);return sum;}`, directory => {
      mkdirSync(join(directory,'src/math'),{recursive:true});
      writeFileSync(join(directory,'src/math/access.ts'),'export function read(data:Float32Array|Float64Array,i:number){return data[i];}');
      expect(()=>auditNumericAccess(directory,'entry.ts')).toThrow('dispatcher remains');
      const report=JSON.parse(readFileSync(join(directory,'numeric-access-report.json'),'utf8'));
      expect(report.violations[0].function).toBe('value');
      expect(report.violations[0].localLoop).toBe(false);
    });
  });
  it('traces stored closures and callbacks forwarded into custom loops', () => {
    fixture(`import {read} from './src/math/access.js';
      function loop(callback:()=>number){let sum=0;for(let i=0;i<4;i++)sum+=callback();return sum;}
      function forward(callback:()=>number){return loop(callback);}
      export function run(data:Float32Array|Float64Array){const value=()=>read(data,0);return forward(value);}`, directory => {
      mkdirSync(join(directory,'src/math'),{recursive:true});
      writeFileSync(join(directory,'src/math/access.ts'),'export function read(data:Float32Array|Float64Array,i:number){return data[i];}');
      expect(()=>auditNumericAccess(directory,'entry.ts')).toThrow('dispatcher remains');
      const report=JSON.parse(readFileSync(join(directory,'numeric-access-report.json'),'utf8'));
      expect(report.violations[0].localLoop).toBe(false);
      expect(report.violations[0].calledFromLoop).toBe(true);
    });
  });
  it('accepts concrete kernels after direct-access lowering', () => {
    fixture(`import {read} from './src/math/access.js';
      function sum<T extends Float32Array|Float64Array>(data:T){let result=0;for(let i=0;i<data.length;i++)result+=read(data,i);return result;}
      export function run(data:Float32Array|Float64Array){if(data instanceof Float32Array)return sum(data);return sum(data);}`, directory => {
      mkdirSync(join(directory,'src/math'),{recursive:true});
      writeFileSync(join(directory,'src/math/access.ts'),'export function read(data:Float32Array|Float64Array,i:number){return data[i];}');
      specializeStorageLoops(directory,'entry.ts');lowerConcreteAccess(directory,'entry.ts');
      expect(auditNumericAccess(directory,'entry.ts').violations).toEqual([]);
    });
  });
});

it('preserves atlas overlapping-buffer order and invalid source length rejection', () => {
  const input=new Uint8Array([1,2,3,4,5,6,7,8,0,0,0,0]);
  const placement={x:1,y:0,width:2,height:1,index:0,layer:0};
  writeRawAtlasPlacement(input,3,placement,{image:{width:2,height:1,data:input.subarray(0,8)},flipY:false},false);
  expect([...input]).toEqual([1,2,3,4,1,2,3,4,1,2,3,4]);
  expect(()=>writeRawAtlasPlacement(input,3,placement,{image:{width:2,height:1,data:new Uint8Array(7)},flipY:false},false)).toThrow('RGBA source length');
});
