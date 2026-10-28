import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {serve,ready,root} from './reference-capture.mjs';
import {launchChrome} from './reference-runtime.mjs';
const input=process.env.MUTRACER_OIDN_DISPLAY_INPUT;if(!input)throw Error('Set MUTRACER_OIDN_DISPLAY_INPUT');
const out=resolve(process.env.MUTRACER_PARITY_OUTPUT);mkdirSync(out,{recursive:true});
const server=await serve(root,out,resolve(root,'tests/gpu/displayFrozen.ts'));let chrome;
try{chrome=await launchChrome();const page=await chrome.page(server.url+'?input='+encodeURIComponent('/@fs/'+input));try{await ready(page.tab);const result=await page.tab.evaluate('window.runBenchmark()');writeFileSync(resolve(out,'browser-result.json'),JSON.stringify(result,null,2));console.log(result);if(!result.passed)process.exitCode=1;}finally{await page.close();}}finally{await chrome?.close();await server.close();}
