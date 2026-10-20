// Fixed upstream build, excluding only the three optional large weight blobs.
// Device modules remain the ABI-matched official 2.5.1 binaries.
import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const sourceCommit='6602ee2ca38a1a2a02135beed8f6e68eed630180';
const weightsCommit='28883d1769d5930e13cf7f1676dd852bd81ed9e7';
const removed=['rt_alb_large','rt_hdr_calb_cnrm_large','rt_nrm_large'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function run(command,args,options={}) {
  const r=spawnSync(command,args,{stdio:'inherit',...options});
  if(r.error||r.status!==0)throw new Error(`${command} failed: ${r.error?.message??r.status}`);
  return r.stdout;
}
function download(url,path,expected) {
  if(existsSync(path)&&(!expected||sha(readFileSync(path))===expected))return;
  const tmp=`${path}.download`;
  run('curl',['-LfsS','--retry','2',url,'-o',tmp]);
  if(expected&&sha(readFileSync(tmp))!==expected)throw new Error(`OIDN checksum mismatch: ${path}`);
  renameSync(tmp,path);
}
export function buildOIDNCore(out) {
  const cache=resolve(out,'oidn-no-large'),source=resolve(cache,`oidn-${sourceCommit}`),build=resolve(cache,'build');
  const mac=process.platform==='darwin',win=process.platform==='win32';
  const core=resolve(build,mac?'libOpenImageDenoise_core.2.5.1.dylib':win?'OpenImageDenoise_core.dll':'libOpenImageDenoise_core.so.2.5.1');
  const api=resolve(build,mac?'libOpenImageDenoise.2.5.1.dylib':win?'OpenImageDenoise.dll':'libOpenImageDenoise.so.2.5.1');
  const stamp=resolve(cache,'verified.json');
  if(existsSync(stamp)&&existsSync(core)&&existsSync(api)) {
    const info=JSON.parse(readFileSync(stamp,'utf8'));
    if(info.sourceCommit===sourceCommit&&info.coreSha256===sha(readFileSync(core))&&info.apiSha256===sha(readFileSync(api)))return {core,api};
  }
  mkdirSync(cache,{recursive:true});
  if(!existsSync(resolve(source,'CMakeLists.txt'))) {
    const archive=resolve(cache,'source.tar.gz');
    download(`https://codeload.github.com/RenderKit/oidn/tar.gz/${sourceCommit}`,archive,'026a777d76c8e65a7a19e7f490f2ad5f6ecde316e907f6620b56bacf392733ea');
    run('tar',['-xzf',archive,'-C',cache]);
  }
  // Verify the exact source pattern instead of applying a fuzzy vendor patch.
  const cmakePath=resolve(source,'CMakeLists.txt'),filterPath=resolve(source,'core/rt_filter.cpp');
  let cmake=readFileSync(cmakePath,'utf8'),filter=readFileSync(filterPath,'utf8');
  if(!cmake.includes('# MuTracer: no large weights')) {
    for(const name of removed) {
      if(!cmake.includes(`    weights/${name}.tza\n`)||!filter.includes(`blobs::weights::${name}`))throw new Error('Unexpected OIDN source for no-large build');
      cmake=cmake.replace(`    weights/${name}.tza\n`,'');
      filter=filter.replace(`  #include "weights/${name}.h"\n`,'').replace(`blobs::weights::${name}`,'nullptr');
    }
    // Generate matching CPU/Metal configuration without rebuilding their official
    // modules or introducing ISPC/TBB build dependencies for this small example.
    cmake=cmake.replace('add_subdirectory(devices)','# MuTracer: use official ABI-matched CPU/Metal modules.');
    cmake='# MuTracer: no large weights; modified from fixed upstream source.\n'+cmake;
    filter='// MuTracer modification: optional large weights omitted.\n'+filter;
    writeFileSync(cmakePath,cmake);writeFileSync(filterPath,filter);
  }
  const weights=[...cmake.matchAll(/weights\/([\w]+\.tza)/g)].map(m=>m[1]);
  if(weights.length!==20||weights.some(n=>n.includes('_large')))throw new Error('Unexpected OIDN weight set');
  mkdirSync(resolve(source,'weights'),{recursive:true});
  for(const name of weights) {
    // Upstream Git LFS pointer supplies the content hash, pinned by commit;
    // fetch blobs directly so the build does not require Git LFS installation.
    const pointer=resolve(cache,`${name}.pointer`);
    download(`https://raw.githubusercontent.com/RenderKit/oidn-weights/${weightsCommit}/${name}`,pointer);
    const metadata=readFileSync(pointer,'utf8'),hash=metadata.match(/^oid sha256:([0-9a-f]{64})$/m)?.[1];
    const size=Number(metadata.match(/^size (\d+)$/m)?.[1]);
    if(!hash||!Number.isSafeInteger(size)||size<=0||size>16*1024*1024)throw new Error('Invalid pinned OIDN weight metadata');
    const path=resolve(source,'weights',name);
    download(`https://media.githubusercontent.com/media/RenderKit/oidn-weights/${weightsCommit}/${name}`,path,hash);
    if(readFileSync(path).length!==size)throw new Error('Invalid OIDN weight length');
  }
  run('cmake',['-S',source,'-B',build,
    ...(mac?['-DCMAKE_MAKE_PROGRAM=/usr/bin/make','-DOIDN_DEVICE_METAL=ON','-DCMAKE_OSX_ARCHITECTURES=arm64','-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0']:
      win?['-G','Ninja']:[]),
    '-DCMAKE_BUILD_TYPE=Release','-DOIDN_DEVICE_CPU=ON','-DOIDN_APPS=OFF','-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
    ...(!mac&&!win?['-DCMAKE_INSTALL_RPATH=$ORIGIN']:[])]);
  run('cmake',['--build',build,'--config','Release','--target','OpenImageDenoise_core','OpenImageDenoise','--parallel','8']);
  const symbols=run(win?'dumpbin':'nm',win?['/exports',core]:[...(mac?['-gU']:['-D','--defined-only']),core],{stdio:['ignore','pipe','inherit'],encoding:'utf8',maxBuffer:4*1024*1024});
  if(removed.some(name=>symbols.includes(name)))throw new Error('Large weights remain in OIDN binary');
  writeFileSync(stamp,JSON.stringify({sourceCommit,weightsCommit,removed,coreSha256:sha(readFileSync(core)),apiSha256:sha(readFileSync(api))},null,2)+'\n');
  return {core,api};
}
