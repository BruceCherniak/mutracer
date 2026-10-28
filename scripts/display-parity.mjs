import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {serve,ready,root} from './reference-capture.mjs';
import {launchChrome} from './reference-runtime.mjs';
const out=resolve(process.env.MUTRACER_PARITY_OUTPUT??'.cache/display-parity');mkdirSync(out,{recursive:true});
const table=JSON.parse(readFileSync(resolve(root,'tests/fixtures/display-order.json')));
const server=await serve(root,out,resolve(root,'tests/gpu/displayParity.js'));let chrome;
try{if(!process.argv.includes('--compare-only')){chrome=await launchChrome();for(const backend of ['webgpu','webgl']){const page=await chrome.page(server.url+(backend==='webgl'?'?webgl':''));try{await ready(page.tab);console.log(await page.tab.evaluate('window.runBenchmark()'));}finally{await page.close();}}}}finally{await chrome?.close();await server.close();}
if(process.argv.includes('--browser-only'))process.exit(0);
const traces=[];
for(const backend of ['native','webgpu','webgl']){
 const rows=JSON.parse(readFileSync(resolve(out,backend+'-trace.json')));
 const expectedNames=table.cases.filter(r=>backend!=='webgl'||!r.hdr&&r.webgl!==false).map(r=>r.name);
 if(JSON.stringify(rows.map(r=>r.name))!==JSON.stringify(expectedNames))throw Error(backend+' scenario coverage differs');
 for(const row of table.cases)if(row[backend+'Trace']&&(!row[backend+'TraceExceptions']?.length||row[backend+'TraceExceptions'].some(name=>!table.exceptions[name])))throw Error('Trace override needs named exceptions: '+row.name);
 for(const row of rows){const expected=table.cases.find(r=>r.name===row.name);traces.push({backend,case:row.name,actual:row.trace,expected:expected[backend+'Trace']??expected.trace,passed:JSON.stringify(row.trace)===JSON.stringify(expected[backend+'Trace']??expected.trace)});}
}
const results=[];
for(const row of table.cases){
 const names=row.hdr||row.webgl===false?['native','webgpu']:['native','webgpu','webgl'];
 for(let i=0;i<names.length;i++)for(let j=i+1;j<names.length;j++){
  const path=b=>resolve(out,b+'-'+row.name+(row.hdr?'.f32':'.rgba8'));
  const a=readFileSync(path(names[i])),b=readFileSync(path(names[j]));if(a.length!==b.length)throw Error('Image sizes differ');
  let max=0;for(let k=0;k<a.length;k+=row.hdr?4:1){const x=row.hdr?a.readFloatLE(k):a[k],y=row.hdr?b.readFloatLE(k):b[k];max=Math.max(max,row.hdr?Math.abs(x-y)/Math.max(1,Math.abs(x),Math.abs(y)):Math.abs(x-y));}
  const tolerance=row.tolerance??(row.hdr?.0015:2);results.push({case:row.name,pair:[names[i],names[j]],maxDifference:max,tolerance,passed:Number.isFinite(max)&&max<=tolerance});
 }
}
const report={passed:results.every(r=>r.passed)&&traces.every(r=>r.passed),traces,exceptions:table.exceptions,results};writeFileSync(resolve(out,'comparison.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
