import {build} from 'esbuild';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??'.native-build/postprocess-shaders');
mkdirSync(out,{recursive:true});
const bundle=await build({stdin:{contents:`export {postprocessParameters,bloomParameters} from './native/src/postprocess.ts';
export {viewerParameters} from './native/src/viewer-core.ts';
export {nextPreviewScale} from './src/renderer/util.ts';
export {updateProgressiveState} from './src/renderer/progressiveScheduler.ts';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node'});
const {postprocessParameters,bloomParameters,viewerParameters,nextPreviewScale,updateProgressiveState}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const decode=bytes=>JSON.parse(new TextDecoder().decode(bytes));
const reference={sources:decode(postprocessParameters()),bloom:[],viewer:[],scales:[],traces:[]};
for(let radius of [0,.01,.1,.5,.6,1,2]) {
 radius=Math.fround(radius);
 reference.bloom.push({radius,expected:decode(bloomParameters(radius)).map(Math.fround)});
}
const viewer=(kind,args)=>reference.viewer.push({kind,args,expected:decode(viewerParameters(kind,new Uint8Array(new Float64Array(args).buffer)))});
for(const time of [0,5.5,6,12,15,18,18.5,24])viewer(0,[time]);
for(const radius of [.0001,.01,1,10])for(const rotation of [-180,0,30,180])for(const ground of [0,5])
 viewer(1,[.3,.4,-.2,radius,45,15,3,2,1,.5,1.2,rotation,1.5,ground]);
viewer(2,[]);
for(const scale of [.015625,.0625,.125,.249,.25,.5,1])for(const ms of [0,.1,4,16,20,25,80,1e6])
 for(const current of [scale,Math.min(1,scale*1.15),Math.max(.015625,scale/1.15)]) {
  const args=[scale,ms,20,.75,current,.015625];reference.scales.push({args,expected:nextPreviewScale(...args)});
 }
for(const idleMs of [0,150])for(let mask=0;mask<16;mask++) {
 let state={previousChanged:false,lastContinuousChange:-Infinity,changing:false};const events=[];
 for(let i=0;i<8;i++) {
  const changed=!!(mask&(1<<(i%4))),active=i===2||i===3,now=i*50;
  state=updateProgressiveState(state,changed,active,now,idleMs);
  events.push({changed,active,now,expected:state});
 }
 reference.traces.push({idleMs,events});
}
const path=resolve(out,'reference.json');
writeFileSync(path,JSON.stringify(reference));
const result=spawnSync('cargo',['test','--locked','--manifest-path','native/host/Cargo.toml','--lib',
 'shared_postprocess','--'],
 {env:{...process.env,MUTRACER_POSTPROCESS_SOURCES:path},encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});
writeFileSync(resolve(out,'aot-comparison.log'),(result.stdout??'')+(result.stderr??''));
if(result.error||result.status!==0)throw result.error??Error(`AOT/JS postprocess comparison failed; see ${out}/aot-comparison.log`);
if(!/test result: ok\. 2 passed; 0 failed;/.test(result.stdout??''))throw Error('Expected both shader/math and native loop policy checks to run');
writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,shaders:['bloom','auxiliary','normalize','frame_resolve','oidn_display','oidn_composition[0]','oidn_composition[1]'],bloom:reference.bloom.length,viewer:reference.viewer.length,scales:reference.scales.length,traces:reference.traces.length})+'\n');
console.log('Shared postprocess shaders, Bloom parameters, viewer math and native loop policies match JS');
