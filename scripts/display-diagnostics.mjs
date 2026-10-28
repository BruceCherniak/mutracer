import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {serve,ready,root} from './reference-capture.mjs';
import {launchChrome} from './reference-runtime.mjs';
const out=resolve(process.env.MUTRACER_PARITY_OUTPUT);mkdirSync(out,{recursive:true});
const server=await serve(root,out,resolve(root,'scripts/reference-browser.ts'));let chrome;
try{chrome=await launchChrome();for(const backend of ['webgpu','webgl']){const page=await chrome.page(server.url+'?diagnostics'+(backend==='webgl'?'&webgl':''));try{await ready(page.tab);console.log(await page.tab.evaluate('window.runBenchmark()'));}finally{await page.close();}}}finally{await chrome?.close();await server.close();}
