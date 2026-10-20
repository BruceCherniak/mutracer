// Official pinned native SDK; binary payloads/cache never enter the repository.
import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,readdirSync,copyFileSync,renameSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {buildOIDNCore} from './viewer-oidn-core.mjs';
export function bundleOIDN(out, contents) {
  const version='2.5.1', name=`oidn-${version}.arm64.macos`;
  const cache=resolve(out,'oidn-sdk'), sdk=resolve(process.env.MUTRACER_OIDN_ROOT??resolve(cache,name));
  function run(cmd,args){const r=spawnSync(cmd,args,{stdio:'inherit'});if(r.error||r.status)throw new Error(`${cmd} failed`);}
  if(process.env.MUTRACER_OIDN_ROOT&&!existsSync(resolve(sdk,'lib/libOpenImageDenoise.2.dylib')))throw new Error('MUTRACER_OIDN_ROOT does not contain the native OIDN SDK');
  if(!existsSync(resolve(sdk,'lib/libOpenImageDenoise.2.dylib'))) {
    mkdirSync(cache,{recursive:true});
    const archive=resolve(cache,`${name}.tar.gz`);
    if(!existsSync(archive))run('curl',['-LfsS',`https://github.com/RenderKit/oidn/releases/download/v${version}/${name}.tar.gz`,'-o',archive]);
    if(createHash('sha256').update(readFileSync(archive)).digest('hex')!=='98e0aca8e7ab69e9f4f0191582a500fd8b0d9085d68662f18ab6469e934a6efd')throw new Error('OIDN SDK checksum mismatch');
    run('tar',['-xzf',archive,'-C',cache]);
  }
  for(const name of ['libOpenImageDenoise_core.2.5.1.dylib','libOpenImageDenoise_device_cpu.2.5.1.dylib','libOpenImageDenoise_device_metal.2.5.1.dylib'])if(!existsSync(resolve(sdk,'lib',name)))throw new Error('The no-large core requires the matching OIDN 2.5.1 arm64 CPU/Metal SDK');
  const slim=buildOIDNCore(out);
  const libs=resolve(contents,'Frameworks'), notices=resolve(contents,'Resources/licenses/OIDN');
  mkdirSync(libs,{recursive:true});mkdirSync(notices,{recursive:true});
  for(const name of readdirSync(resolve(sdk,'lib')).filter(n=>n.endsWith('.dylib'))) {
    const target=resolve(libs,`.${name}.build`);
    const source=name.startsWith('libOpenImageDenoise_core.')?slim.core:/^libOpenImageDenoise(?:\.\d+(?:\.\d+)*)?\.dylib$/.test(name)?slim.api:resolve(sdk,'lib',name);
    copyFileSync(source,target);
    if(name.startsWith('libOpenImageDenoise')) {
      const info=spawnSync('/usr/bin/otool',['-l',target],{encoding:'utf8'});
      if(info.status)throw new Error('Could not inspect OIDN loader paths');
      const paths=[...info.stdout.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g)].map(m=>m[1]);
      for(const path of paths)run('/usr/bin/install_name_tool',['-delete_rpath',path,target]);
      run('/usr/bin/install_name_tool',['-add_rpath','@loader_path',target]);
    }
    run('/usr/bin/codesign',['--force','--sign','-',target]);
    renameSync(target,resolve(libs,name));
  }
  writeFileSync(resolve(notices,'MUTRACER-MODIFICATIONS.txt'),'OIDN 2.5.1 core/API rebuilt from commit 6602ee2ca38a1a2a02135beed8f6e68eed630180.\nMuTracer omits rt_alb_large, rt_hdr_calb_cnrm_large and rt_nrm_large weights.\nCPU/Metal device modules remain from the official matching SDK.\n');
  for(const name of ['LICENSE.txt','third-party-programs.txt','third-party-programs-DPCPP.txt','third-party-programs-oneTBB.txt'])copyFileSync(resolve(sdk,'doc',name),resolve(notices,name));
}
