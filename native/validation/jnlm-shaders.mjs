// Compare the entire native AOT JNLM packet against the shared generator in JS.
import {build} from 'esbuild';
import {mkdirSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??'.native-build/jnlm-shaders');
mkdirSync(out,{recursive:true});
const bundled=await build({stdin:{contents:"export {jnlmParameters} from './native/src/jnlm-core.ts'; export {DEFAULT_JNLM_OPTIONS} from './src/renderer/jnlm.ts';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node'});
const {jnlmParameters,DEFAULT_JNLM_OPTIONS:defaults}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const shapes=[
 [defaults.strength,defaults.searchRadius,defaults.patchRadius,defaults.albedoBandwidth,defaults.normalBandwidth,defaults.iterations],
 [.3,2,0,.07,.02,1], [2,7,3,.2,.1,4],
 [.0001,16,3,.0001,10,4], [3,1,0,10,.0001,1]
];
const references=shapes.map(([strength,search,patch,albedo,normal,iterations],i)=>{
 const size=[13+i*2,9+i];
 // Rust options expose f32; pass those exact values to both runtimes.
 strength=Math.fround(strength);albedo=Math.fround(albedo);normal=Math.fround(normal);
 return {size,is_default:i===0,strength,search_radius:search,patch_radius:patch,albedo_bandwidth:albedo,
  normal_bandwidth:normal,iterations,expected:JSON.parse(new TextDecoder().decode(
   jnlmParameters(...size,strength,search,patch,albedo,normal,iterations)))};
});
const path=resolve(out,'references.json');
writeFileSync(path,JSON.stringify(references)+'\n');
const result=spawnSync('cargo',['test','--locked','--manifest-path','native/host/Cargo.toml','--lib',
 'display::jnlm::tests::shared_filter_and_composition_shaders_validate_and_options_reject_invalid_values','--','--exact'],
 {env:{...process.env,MUTRACER_JNLM_SOURCES:path},encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});
writeFileSync(resolve(out,'aot-comparison.log'),(result.stdout??'')+(result.stderr??''));
if(result.error||result.status!==0)throw result.error??Error(`AOT/JS JNLM comparison failed; see ${out}/aot-comparison.log`);
writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,cases:references.length})+'\n');
console.log(`JNLM: ${references.length} AOT/JS shader and uniform packets match exactly`);
