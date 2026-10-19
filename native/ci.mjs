// Reproducible native CI, with outputs isolated from the Web install/build.
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnCompiler} from './compiler.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??mkdtempSync(resolve(tmpdir(),'mutracer-native-ci-')));
mkdirSync(out,{recursive:true});
const compiler=process.env.MUTRACER_SCRIPTC??spawnSync(process.execPath,['native/toolchain/compiler.mjs'],{cwd:root,encoding:'utf8'}).stdout?.trim();
if(!compiler)throw Error('Install native/toolchain optional dependencies or set MUTRACER_SCRIPTC.');
const hostTarget=resolve(out,'host-target'),viewerTarget=resolve(out,'viewer-target'),archive=resolve(out,'render-core.lib.a');
const env={...process.env,MUTRACER_SCRIPTC:compiler,MUTRACER_AOT_ARCHIVE:archive,CARGO_TARGET_DIR:hostTarget,MUTRACER_NATIVE_OUTPUT:out};
const checks=[];
function run(name,command,args,extra={},allowFailure=false){
 const result=(command===compiler?spawnCompiler:spawnSync)(command,args,{cwd:root,env:{...env,...extra},encoding:'utf8',maxBuffer:64*1024*1024,timeout:900000});
 writeFileSync(resolve(out,name+'.log'),(result.stdout??'')+(result.stderr??''));
 checks.push({name,command:[command,...args],exitCode:result.status});writeFileSync(resolve(out,'checks.json'),JSON.stringify(checks,null,2)+'\n');
 if(result.error||result.signal||result.status!==0&&!allowFailure)throw result.error??Error(`${name} failed; see ${out}/${name}.log`);
 console.log(`${name}: ${result.status}`);return result;
}
const version=run('compiler-version',compiler,['--version']);
if(version.stdout.trim()!=='0.3.2')throw Error('Native CI requires scriptc0.3.2.');
run('aot-build',compiler,['build','--lib','--profile','native/render-core-profile.json','-o',archive]);
run('native-build','cargo',['build','--release','--locked','--manifest-path','native/host/Cargo.toml']);
const probe=run('gpu-availability',resolve(hostTarget,'release/gpu-availability'),[]);
const gpu=JSON.parse(probe.stdout);if(typeof gpu.available!=='boolean')throw Error('Invalid GPU availability result.');
run('host-tests','cargo',['test','--locked','--manifest-path','native/host/Cargo.toml','--','--test-threads=1']);
// Separate target dirs avoid an unhashed multi-crate-type rlib being reused with
// a different wgpu feature graph by the independent viewer manifest.
run('viewer-tests','cargo',['test','--locked','--manifest-path','native/viewer/Cargo.toml'],{CARGO_TARGET_DIR:viewerTarget});
run('build-lib','npm',['run','build:lib']);
run('modules-build',process.execPath,['native/module-check.mjs'],{},true);
const matrix=JSON.parse(readFileSync(resolve(out,'modules/summary.json'),'utf8'));
const required=matrix.results.filter(r=>r.name!=='materials');
if(required.length!==14||required.some(r=>r.status!=='archive-built'))throw Error('Required AOT module failed.');
run('modules-verify','npm',['run','native:modules:verify']);
run('storage-verify','npm',['run','native:storage:verify'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'storage')});
if(gpu.available){
 run('raw-gpu-fixtures','npm',['run','native:scene'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'fixtures'),MUTRACER_NATIVE_SAMPLES:'8'});
 run('ray-query-contracts',resolve(hostTarget,'release/ray-query-probe'),[resolve(out,'ray-query')]);
}else console.log('GPU execution skipped: no adapter; CPU/module/storage checks still ran.');
writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,scriptc:'0.3.2',gpu,requiredModules:required.length,checks},null,2)+'\n');
