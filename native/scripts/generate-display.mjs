import {readFileSync,writeFileSync} from 'node:fs';
import {nativeDisplayShader,nativeDisplayEffectsShader} from '../src/display-shader.ts';
for (const [name, result] of [['display.wgsl',nativeDisplayShader()],['display-effects.wgsl',nativeDisplayEffectsShader()],['display-hdr.wgsl',nativeDisplayEffectsShader(true)]]) {
 const target=new URL('../host/src/'+name,import.meta.url);
 if(process.argv.includes('--check')) {if(readFileSync(target,'utf8')!==result)throw new Error('Regenerate native display shader: '+name);}
 else writeFileSync(target,result);
}
