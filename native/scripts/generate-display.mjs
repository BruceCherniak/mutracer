import {aovDisplayShader} from '../../src/renderer/wgsl/aovDisplay.wgsl.ts';
import aovResolveShader from '../../src/renderer/wgsl/aovResolve.wgsl.ts';
import {readFileSync,writeFileSync} from 'node:fs';
import {nativeDisplayShader,nativeDisplayEffectsShader} from '../src/display-shader.ts';
for (const [name, result] of [['aov-display.wgsl',aovDisplayShader('rgba8unorm')],['aov-display-hdr.wgsl',aovDisplayShader('rgba16float')],['aov-resolve.wgsl',aovResolveShader],['display.wgsl',nativeDisplayShader()],['display-effects.wgsl',nativeDisplayEffectsShader()],['display-hdr.wgsl',nativeDisplayEffectsShader(true)]]) {
 const target=new URL('../host/src/'+name,import.meta.url);
 if(process.argv.includes('--check')) {if(readFileSync(target,'utf8')!==result)throw new Error('Regenerate native display shader: '+name);}
 else writeFileSync(target,result);
}
