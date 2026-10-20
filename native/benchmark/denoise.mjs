// Local, sequential CPU/CUDA/oidn-web comparison. All evidence stays outside Git.
import {createServer} from 'vite';
import {mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync} from 'node:fs';
import {resolve, relative, isAbsolute, dirname, delimiter} from 'node:path';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../..');
const args=process.argv.slice(2), option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
if(!args.includes('--output')||!args.includes('--native')||!args.includes('--oidn')||!args.includes('--model'))
  throw Error('Usage: node native/benchmark/denoise.mjs --output OUTSIDE_REPO --native DENOISE_BENCHMARK --oidn OIDN_LIBRARY --model MODEL.gltf [--port 4207]');
const output=resolve(option('--output')), model=resolve(option('--model')), native=resolve(option('--native')), oidn=resolve(option('--oidn'));
const inside=relative(root,output);
if(!inside||(!inside.startsWith('..')&&!isAbsolute(inside)))throw Error('Evidence must be outside the repository');
mkdirSync(output,{recursive:true});
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
for(const name of ['denoise.mjs','denoise-browser.mjs'])copyFileSync(resolve(root,'native/benchmark',name),resolve(output,name));
writeFileSync(resolve(output,'oidn-libraries.json'),JSON.stringify(Object.fromEntries(readdirSync(dirname(oidn)).filter(name=>/^OpenImageDenoise.*\.dll$|^libOpenImageDenoise.*\.(?:so(?:\.\d+)*|dylib)$/.test(name)).map(name=>[name,sha(resolve(dirname(oidn),name))])),null,2));
writeFileSync(resolve(output,'run.json'),JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),node:process.version,model,modelSha256:sha(model),native, nativeSha256:sha(native),oidn,oidnSha256:sha(oidn),weightsSha256:sha(resolve(root,'oidn/weights/rt_hdr_alb_nrm.tza'))},null,2));
writeFileSync(resolve(output,'source.diff'),execFileSync('git',['diff','HEAD'],{cwd:root}));
async function handle(req,res,next){
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>MuTracer OIDN benchmark</title><pre>Starting…</pre><canvas width="640" height="360"></canvas><script type="module" src="/native/benchmark/denoise-browser.mjs"></script>');return;}
    if(url.pathname==='/denoise-config') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'/\u0040fs/'+model.replaceAll('\\','/'),sizes:[[640,360],[1280,720],[1920,1080]],rounds:3,iterations:7}));return;}
    if(url.pathname==='/evidence'&&req.method==='POST') {
      const name=url.searchParams.get('name');
      if(!/^[\w.-]+(?:\/[\w.-]+)*$/.test(name)||name.split('/').some(part=>part==='..'||part==='.'))throw Error('Invalid evidence path');
      const path=resolve(output,name),chunks=[];for await(const chunk of req)chunks.push(chunk);
      mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,Buffer.concat(chunks));res.end('ok');return;
    }
    if(url.pathname==='/denoise-native'&&req.method==='POST') {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const {key,width,height,backend,round,iterations}=JSON.parse(Buffer.concat(chunks));
      if(key!==`${width}x${height}`||!/^\d+x\d+$/.test(key)||![0,1,3].includes(backend)||![0,1,2].includes(round)||iterations!==7)throw Error('Invalid native job');
      const target=resolve(output,`${key}/round-${round}/${backend===1?'cpu':backend===3?'cuda':'auto'}`);
      const env={...process.env};
      const pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path')??'PATH';env[pathKey]=dirname(oidn)+delimiter+(env[pathKey]??'');
      const result=await promisify(execFile)(native,[oidn,resolve(output,key),String(width),String(height),String(backend),String(iterations),target],{timeout:300000,env,maxBuffer:1024*1024});
      res.setHeader('Content-Type','application/json');res.end(readFileSync(resolve(target,'result.json')));console.log(result.stdout.trim());return;
    }
    next();
  } catch(error) {console.error(error);res.statusCode=500;res.end(String(error));}
}
const server=await createServer({root,configFile:false,plugins:[{name:'oidn-benchmark',configureServer(server){server.middlewares.use(handle);}}],optimizeDeps:{entries:['native/benchmark/denoise-browser.mjs']},resolve:{alias:{'@meimu/mutracer':resolve(root,'src/main.ts')}},server:{host:'127.0.0.1',port:Number(option('--port',4207)),strictPort:true,hmr:false,watch:{ignored:['**/*']},fs:{allow:[root,resolve(model,'..')]}}});
await server.listen();console.log(`OIDN benchmark: http://127.0.0.1:${server.config.server.port}`);
