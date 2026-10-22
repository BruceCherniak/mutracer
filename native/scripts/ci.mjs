// Reproducible native CI, with outputs isolated from the Web install/build.
import {prepareTinyBvh} from '../../scripts/fetch-tinybvh.mjs';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnCompiler} from './compiler.mjs';
import {archiveName,executable,nativeToolchainEnv,windows} from './platform.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gpuValidation=process.argv.includes('--gpu')||process.argv.includes('--hosts');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??mkdtempSync(resolve(tmpdir(),'mutracer-native-ci-')));
mkdirSync(out,{recursive:true});
const compiler=process.env.MUTRACER_SCRIPTC??spawnSync(process.execPath,['native/toolchain/compiler.mjs'],{cwd:root,encoding:'utf8'}).stdout?.trim();
if(!compiler)throw Error('Install native/toolchain optional dependencies or set MUTRACER_SCRIPTC.');
const hostTarget=resolve(out,'host-target'),viewerTarget=resolve(out,'viewer-target'),archive=resolve(out,archiveName('render-core'));
const env={...nativeToolchainEnv(),MUTRACER_SCRIPTC:compiler,MUTRACER_AOT_ARCHIVE:archive,CARGO_TARGET_DIR:hostTarget,MUTRACER_NATIVE_OUTPUT:out};
const checks=[];
function run(name,command,args,extra={},allowFailure=false,timeout=900000){
 if(command==='npm'&&process.env.npm_execpath){args=[process.env.npm_execpath,...args];command=process.execPath;}
 console.log(`${name}...`);
 const result=(command===compiler?spawnCompiler:spawnSync)(command,args,{cwd:root,env:{...env,...extra},encoding:'utf8',maxBuffer:64*1024*1024,timeout});
 writeFileSync(resolve(out,name+'.log'),(result.stdout??'')+(result.stderr??''));
 checks.push({name,command:[command,...args],exitCode:result.status});writeFileSync(resolve(out,'checks.json'),JSON.stringify(checks,null,2)+'\n');
 if(result.error||result.signal||result.status!==0&&!allowFailure)throw result.error??Error(`${name} failed; see ${out}/${name}.log`);
 console.log(`${name}: ${result.status}`);return result;
}
const version=run('compiler-version',compiler,['--version']);
if(version.stdout.trim()!=='0.3.2')throw Error('Native CI requires scriptc0.3.2.');
run('aot-build',compiler,['build','--lib','--profile','native/src/render-core-profile.json','-o',archive]);
await prepareTinyBvh();
run('native-build','cargo',['build','--release','--locked','--manifest-path','native/host/Cargo.toml']);
if(windows)run('windows-dll-exit',process.execPath,['native/validation/windows-dll-exit.mjs']);
let gpu={validated:false,reason:'CPU-only CI; run native:ci:gpu on a real GPU'};
if(gpuValidation){
 const probe=run('gpu-availability',resolve(hostTarget,'release',executable('gpu-availability')),['--require-hardware','--require-ray-query']);
 gpu=JSON.parse(probe.stdout);
 if(!gpu.hardware||!gpu.rayQuery)throw Error('Full GPU validation requires a real GPU with ray-query support.');
}
run('host-tests','cargo',['test','--locked','--manifest-path','native/host/Cargo.toml','--','--test-threads=1']);
// Separate target dirs avoid an unhashed multi-crate-type rlib being reused with
// a different wgpu feature graph by the independent viewer manifest.
run('viewer-tests','cargo',['test','--locked','--manifest-path','native/viewer/Cargo.toml'],{CARGO_TARGET_DIR:viewerTarget});
run('build-lib','npm',['run','build:lib']);
run('modules-build',process.execPath,['native/validation/module-check.mjs'],{},true);
const matrix=JSON.parse(readFileSync(resolve(out,'modules/summary.json'),'utf8'));
const required=matrix.results.filter(r=>r.name!=='materials');
if(required.length!==14||required.some(r=>r.status!=='archive-built'))throw Error('Required AOT module failed.');
run('modules-verify','npm',['run','native:modules:verify']);
run('storage-verify','npm',['run','native:storage:verify'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'storage')});
if(gpuValidation){
 run('host-gpu-tests','cargo',['test','--locked','--manifest-path','native/host/Cargo.toml','--lib','--','--ignored','--test-threads=1']);
 run('viewer-gpu-animation','cargo',['test','--locked','--manifest-path','native/viewer/Cargo.toml','gpu_animated_poses','--','--ignored','--nocapture'],{CARGO_TARGET_DIR:viewerTarget});
 run('raw-gpu-fixtures','npm',['run','native:scene'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'fixtures'),MUTRACER_NATIVE_SAMPLES:'8'},false,1800000);
 run('ray-query-contracts',resolve(hostTarget,'release',executable('ray-query-probe')),[resolve(out,'ray-query')]);
 if(!JSON.parse(readFileSync(resolve(out,'ray-query/result.json'),'utf8')).supported)throw Error('HWRT execution was not validated.');
 // --hosts: the context, job, camera and settings C hosts, reusing the fixtures above.
 if(process.argv.includes('--hosts'))run('c-hosts','npm',['run','native:settings'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'hosts'),
   MUTRACER_NATIVE_SCENE_OUTPUT:resolve(out,'fixtures'),MUTRACER_NATIVE_SAMPLES:'8'});
 run('viewer-build','npm',['run','native:viewer:build'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'viewer'),CARGO_TARGET_DIR:viewerTarget});
 run('viewer-gpu-package','npm',['run','native:viewer:package','--','--gpu'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'viewer')});
 const oracle=readFileSync(resolve(out,'fixtures/incremental-oracle.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 gpu.oracle={passed:oracle.filter(row=>row.pass===true).length,skipped:oracle.filter(row=>row.skipped===true).length};
 if(gpu.oracle.passed+gpu.oracle.skipped!==oracle.length)throw Error('Incomplete incremental render results.');
 gpu.validated=gpu.oracle.skipped===0;
 if(!gpu.validated)gpu.reason=`${gpu.oracle.skipped} full-reference renders failed; review skipped oracle cases before release`;
 console.log(`GPU validation coverage: ${JSON.stringify(gpu)}`);
}else{
 run('scene-static','npm',['run','native:scene:static'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'fixtures')});
 console.log('GPU rendering, HWRT execution and windows NOT VALIDATED (CPU-only CI).');
}
writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,scriptc:'0.3.2',gpu,requiredModules:required.length,checks},null,2)+'\n');
