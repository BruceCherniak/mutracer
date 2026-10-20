import {readFileSync,writeFileSync} from 'node:fs';
import {nativeDisplayShader} from '../src/display-shader.ts';
const target=new URL('../host/src/display.wgsl',import.meta.url);
const result=nativeDisplayShader();
if(process.argv.includes('--check')) {if(readFileSync(target,'utf8')!==result)throw new Error('Regenerate native display shader');}
else writeFileSync(target,result);
