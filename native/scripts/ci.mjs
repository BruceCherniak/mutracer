// Reproducible native CI, with outputs isolated from the Web install/build.
import {prepareTinyBvh} from '../../scripts/fetch-tinybvh.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {closeSync,mkdirSync,openSync,readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnCompiler} from './compiler.mjs';
import {classifyHostGpuResult,hwrtLoopIterations} from './host-gpu-results.mjs';
import {archiveName,executable,nativeToolchainEnv,windows} from './platform.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gpuValidation=process.argv.includes('--gpu')||process.argv.includes('--hosts');
const loopIterations=gpuValidation?hwrtLoopIterations(process.env.MT_LOOP_ITERATIONS):undefined;
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??mkdtempSync(resolve(tmpdir(),'mutracer-native-ci-')));
mkdirSync(out,{recursive:true});
const compiler=process.env.MUTRACER_SCRIPTC??spawnSync(process.execPath,['native/toolchain/compiler.mjs'],{cwd:root,encoding:'utf8'}).stdout?.trim();
if(!compiler)throw Error('Install native/toolchain optional dependencies or set MUTRACER_SCRIPTC.');
const hostTarget=resolve(out,'host-target'),viewerTarget=resolve(out,'viewer-target'),archive=resolve(out,archiveName('render-core'));
const env={...nativeToolchainEnv(),MUTRACER_SCRIPTC:compiler,MUTRACER_AOT_ARCHIVE:archive,CARGO_TARGET_DIR:hostTarget,MUTRACER_NATIVE_OUTPUT:out};
// Scene and viewer builds link the archive built here instead of recompiling it.
const prebuilt={MUTRACER_AOT_PREBUILT:archive};
const checks=[],ciStarted=performance.now();
const seconds=started=>Math.round((performance.now()-started)/100)/10;
function record(name,command,args,exitCode,started,fields={}){
 const check={name,command:[command,...args],exitCode,seconds:seconds(started),...fields};
 checks.push(check);writeFileSync(resolve(out,'checks.json'),JSON.stringify(checks,null,2)+'\n');
 console.log(`${name}: ${exitCode} (${check.seconds} s)`);return check;
}
// scriptc staging is synchronous; these steps run before any concurrent lane.
function runSync(name,command,args){
 console.log(`${name}...`);const started=performance.now();
 const result=(command===compiler?spawnCompiler:spawnSync)(command,args,{cwd:root,env,encoding:'utf8',maxBuffer:64*1024*1024,timeout:900000});
 writeFileSync(resolve(out,name+'.log'),(result.stdout??'')+(result.stderr??''));
 record(name,command,args,result.status,started);
 if(result.error||result.signal||result.status!==0)throw result.error??Error(`${name} failed; see ${out}/${name}.log`);
 return result;
}
// Output goes straight to the log file, so concurrent steps never block on a pipe.
async function run(name,command,args,extra={},{allowFailure=false,timeout=900000,log=resolve(out,name+'.log'),fields}={}){
 if(command==='npm'&&process.env.npm_execpath){args=[process.env.npm_execpath,...args];command=process.execPath;}
 console.log(`${name}...`);const started=performance.now(),fd=openSync(log,'w');
 const result=await new Promise(done=>{
  const child=spawn(command,args,{cwd:root,env:{...env,...extra},stdio:['ignore',fd,fd]});
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  child.on('error',error=>{clearTimeout(timer);done({error});});
  child.on('close',(status,signal)=>{clearTimeout(timer);done({status,signal});});
 });
 closeSync(fd);
 const check=record(name,command,args,result.status,started,fields);
 if(result.error||result.signal||result.status!==0&&!allowFailure)throw result.error??Error(`${name} failed; see ${log}`);
 return {...result,check,output:readFileSync(log,'utf8')};
}
const version=runSync('compiler-version',compiler,['--version']);
if(version.stdout.trim()!=='0.3.2')throw Error('Native CI requires scriptc0.3.2.');
runSync('aot-build',compiler,['build','--lib','--profile','native/src/render-core-profile.json','-o',archive]);
await prepareTinyBvh();
await run('native-build','cargo',['build','--release','--locked','--manifest-path','native/host/Cargo.toml']);
if(windows)await run('windows-dll-exit',process.execPath,['native/validation/windows-dll-exit.mjs']);
let gpu={validated:false,reason:'CPU-only CI; run native:ci:gpu on a real GPU'};
if(gpuValidation){
 const probe=runSync('gpu-availability',resolve(hostTarget,'release',executable('gpu-availability')),['--require-hardware','--require-ray-query']);
 gpu=JSON.parse(probe.stdout);
 if(!gpu.hardware||!gpu.rayQuery)throw Error('Full GPU validation requires a real GPU with ray-query support.');
}
await run('host-tests','cargo',['test','--locked','--manifest-path','native/host/Cargo.toml','--','--test-threads=1']);
// Separate target dirs avoid an unhashed multi-crate-type rlib being reused with
// a different wgpu feature graph by the independent viewer manifest.
await run('viewer-tests','cargo',['test','--locked','--manifest-path','native/viewer/Cargo.toml'],{CARGO_TARGET_DIR:viewerTarget});
// CPU-only work runs beside the GPU steps; no GPU work ever runs concurrently.
const lane=work=>work().then(()=>null,error=>error);
const modulesLane=lane(async()=>{
 await run('build-lib','npm',['run','build:lib']);
 await run('modules-build',process.execPath,['native/validation/module-check.mjs'],{},{allowFailure:true});
 const matrix=JSON.parse(readFileSync(resolve(out,'modules/summary.json'),'utf8'));
 const required=matrix.results.filter(r=>r.name!=='materials');
 if(required.length!==14||required.some(r=>r.status!=='archive-built'))throw Error('Required AOT module failed.');
 await run('modules-verify','npm',['run','native:modules:verify']);
 await run('storage-verify','npm',['run','native:storage:verify'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'storage')});
 return required.length;
});
// The release viewer has its own target dir, so it never waits on the test builds' lock.
const viewerLane=gpuValidation&&lane(()=>run('viewer-build','npm',['run','native:viewer:build'],
 {MUTRACER_NATIVE_OUTPUT:resolve(out,'viewer'),CARGO_TARGET_DIR:resolve(out,'viewer-release-target'),...prebuilt}));
const joinLane=async pending=>{const error=await pending;if(error)throw error;};
let hostGpuTests;
if(gpuValidation){
 hostGpuTests=await runHostGpuTests();
 await run('viewer-gpu-animation','cargo',['test','--locked','--manifest-path','native/viewer/Cargo.toml','gpu_animated_poses','--','--ignored','--nocapture'],{CARGO_TARGET_DIR:viewerTarget});
 await run('raw-gpu-fixtures','npm',['run','native:scene'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'fixtures'),MUTRACER_NATIVE_SAMPLES:'8',...prebuilt},{timeout:1800000});
 // A standalone window uses the SDK surface path, separate from egui's surface.
 const surfaceArgs=['run','--locked','--manifest-path','native/viewer/Cargo.toml','--example','surface','--',resolve(out,'fixtures/image/scene-input.bin'),resolve(out,'surface/summary.json')];
 const surfaceEnv={CARGO_TARGET_DIR:viewerTarget,MUTRACER_NATIVE_GPU_VALIDATION:'1'};
 if(process.platform==='linux'&&!env.XDG_RUNTIME_DIR){surfaceEnv.XDG_RUNTIME_DIR=resolve(out,'surface/runtime');mkdirSync(surfaceEnv.XDG_RUNTIME_DIR,{recursive:true,mode:0o700});}
 await run('viewer-gpu-surface',process.platform==='linux'?'xvfb-run':'cargo',process.platform==='linux'?['-a','cargo',...surfaceArgs]:surfaceArgs,surfaceEnv);
 await run('ray-query-contracts',resolve(hostTarget,'release',executable('ray-query-probe')),[resolve(out,'ray-query')]);
 if(!JSON.parse(readFileSync(resolve(out,'ray-query/result.json'),'utf8')).supported)throw Error('HWRT execution was not validated.');
 // --hosts: the context, job, camera, settings and engine C hosts, reusing the fixtures above.
 if(process.argv.includes('--hosts'))await run('c-hosts','npm',['run','native:engine'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'hosts'),
   MUTRACER_NATIVE_SCENE_OUTPUT:resolve(out,'fixtures'),MUTRACER_NATIVE_SAMPLES:'8'});
 await joinLane(viewerLane);
 await run('viewer-gpu-package','npm',['run','native:viewer:package','--','--gpu'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'viewer')});
 const oracle=readFileSync(resolve(out,'fixtures/incremental-oracle.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 gpu.oracle={passed:oracle.filter(row=>row.pass===true).length,skipped:oracle.filter(row=>row.skipped===true).length};
 if(gpu.oracle.passed+gpu.oracle.skipped!==oracle.length)throw Error('Incomplete incremental render results.');
 gpu.validated=gpu.oracle.skipped===0&&hostGpuTests.knownOpenHwrtFailures===0;
 if(!gpu.validated)gpu.reason=[
  gpu.oracle.skipped&&`${gpu.oracle.skipped} full-reference renders failed`,
  hostGpuTests.knownOpenHwrtFailures&&`${hostGpuTests.knownOpenHwrtFailures} known-open Metal HWRT image mismatches`,
 ].filter(Boolean).join('; ')+'; review failures before release';
 console.log(`GPU validation coverage: ${JSON.stringify(gpu)}`);
}else{
 await run('scene-static','npm',['run','native:scene:static'],{MUTRACER_NATIVE_OUTPUT:resolve(out,'fixtures'),...prebuilt});
 console.log('GPU rendering, HWRT execution and windows NOT VALIDATED (CPU-only CI).');
}
await joinLane(modulesLane);
const totalSeconds=seconds(ciStarted);
console.log(`Native CI: ${totalSeconds} s`);
writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,scriptc:'0.3.2',gpu,hostGpuTests,requiredModules:14,totalSeconds,checks},null,2)+'\n');

// Each ignored test runs in its own process, so a panic cannot poison the shared
// test lock for the rest. The HWRT loop runs fewer iterations than its default.
async function runHostGpuTests(){
 const cargo=['test','--locked','--manifest-path','native/host/Cargo.toml','--lib'];
 const started=performance.now(),logs=resolve(out,'host-gpu-tests');mkdirSync(logs,{recursive:true});
 const listing=await run('host-gpu-tests-list','cargo',[...cargo,'--','--ignored','--list','--format=terse'],{},{log:resolve(logs,'list.log')});
 const tests=[...listing.output.matchAll(/^(\S+): test$/gm)].map(match=>match[1]);
 if(!tests.length)throw Error('No ignored host GPU tests were listed.');
 const results=[];
 for(const test of tests){
  const log=resolve(logs,test.replace(/[^\w.-]+/g,'_')+'.log');
  const result=await run(`host-gpu-test ${test}`,'cargo',[...cargo,'--','--ignored','--exact',test,'--test-threads=1'],
   {MT_LOOP_ITERATIONS:String(loopIterations)},{allowFailure:true,log});
  results.push({test,...classifyHostGpuResult(test,result,gpu),seconds:result.check.seconds,log});
 }
 const failed=results.filter(r=>r.status==='failed'),open=results.filter(r=>r.status==='known-open-hwrt-failure');
 const summary={tests:results.length,passed:results.length-failed.length-open.length,failed:failed.length,knownOpenHwrtFailures:open.length,
  hwrtLoopIterations:loopIterations,seconds:seconds(started),results};
 writeFileSync(resolve(logs,'summary.json'),JSON.stringify(summary,null,2)+'\n');
 for(const r of open)console.log(`host-gpu-tests: known-open HWRT failure in ${r.test}: ${r.failure}`);
 console.log(`host-gpu-tests: ${summary.passed}/${summary.tests} passed, ${open.length} known-open HWRT failures (${summary.seconds} s)`);
 if(failed.length)throw Error(`Host GPU tests failed: ${failed.map(r=>r.test).join(', ')}; see ${logs}`);
 return summary;
}
