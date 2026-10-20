import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??resolve(root,'.native-build/context-core'));
const raw=resolve(out,'raw'),target=resolve(process.env.CARGO_TARGET_DIR??resolve(out,'cargo-target'));
const samples=Number(process.env.MUTRACER_NATIVE_SAMPLES??256);
if(!Number.isInteger(samples)||samples<8||samples>4096)throw new Error('Context validation samples must be 8..4096');
mkdirSync(out,{recursive:true});
const env={...process.env,CARGO_TARGET_DIR:target,MUTRACER_NATIVE_OUTPUT:raw,MUTRACER_NATIVE_SAMPLES:String(samples),MUTRACER_AOT_ARCHIVE:resolve(raw,'render-core.lib.a')};
const checks=[];
function run(name,command,args){
 console.log(`${name}...`);
 const result=spawnSync(command,args,{cwd:root,env,encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024});
 writeFileSync(resolve(out,`${name}.log`),(result.stdout??'')+(result.stderr??''));
 checks.push({name,exitCode:result.status});writeFileSync(resolve(out,'checks.json'),JSON.stringify(checks,null,2)+'\n');
 if(result.error||result.status!==0)throw new Error(`${name}: ${result.error?.message??result.stderr??result.stdout}`);
 return result;
}
// The raw driver gates the unchanged AOT graphs and existing one-shot C ABI first.
run('raw-scene-validation',process.execPath,['native/validation/scene-render.mjs']);
run('rust-tests','cargo',['test','--locked','--manifest-path','native/host/Cargo.toml']);
const host=resolve(out,'context-host');
run('context-host-build',process.env.CC??'cc',['-Wall','-Wextra','-Werror','-I','native/include','native/examples/context-host.c','-L',resolve(target,'release'),'-lmutracer_native_probe',`-Wl,-rpath,${resolve(target,'release')}`,'-pthread','-o',host]);
const fixtures=JSON.parse(readFileSync(resolve(raw,'scene-verification.json'))).results;
const results=[];
for(const {variant} of fixtures){
 const source=resolve(raw,variant==='baseline'?'image':variant),destination=resolve(out,variant);
 mkdirSync(destination,{recursive:true});
 const result=run(`context-${variant}`,host,[resolve(source,'scene-input.bin'),source,destination,String(samples)]);
 const match=/PASS (\d+) context checks/.exec(result.stdout);if(!match)throw new Error(`Missing lifecycle checks for ${variant}`);
 for(const name of ['render','normal','albedo'])
  if(!readFileSync(resolve(source,`${name}.rgba32f`)).equals(readFileSync(resolve(destination,`${name}.rgba32f`))))throw new Error(`Context image differs: ${variant}/${name}`);
 // Context HDR bytes already matched; the same pixels have the same native preview.
 copyFileSync(resolve(source,'render.png'),resolve(destination,'render.png'));
 results.push({variant,checks:Number(match[1]),samples,allOutputsByteIdentical:true});
 writeFileSync(resolve(out,'context-verification.json'),JSON.stringify({complete:false,results},null,2)+'\n');
}
writeFileSync(resolve(out,'context-verification.json'),JSON.stringify({complete:true,results},null,2)+'\n');
console.log(`Persistent native contexts: ${results.length} scenes; ${results.reduce((sum,r)=>sum+r.checks,0)} C checks passed`);
