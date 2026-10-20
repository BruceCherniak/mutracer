// Official pinned native SDK; binary payloads/cache never enter the repository.
import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,readdirSync,copyFileSync,renameSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {buildOIDNCore} from './viewer-oidn-core.mjs';
import {viewerPlatform} from './platform.mjs';
export function bundleOIDN(out, contents) {
  const platform=viewerPlatform(),mac=platform==='macos-arm64',win=platform==='windows-x64';
  const version='2.5.1', name=`oidn-${version}.${mac?'arm64.macos':win?'x64.windows':'x86_64.linux'}`;
  const extension=win?'zip':'tar.gz';
  const expected=mac?'98e0aca8e7ab69e9f4f0191582a500fd8b0d9085d68662f18ab6469e934a6efd':
    win?'f11f91bc072a5e3a564515724cb72ab8fcfbc445c84a84c197ff9b16cc01396f':'743c3e2aff8c220d5d70fe6cb970fb3d36f2702d2693c61d1d148e404cf37cd6';
  const cache=resolve(out,'oidn-sdk'), sdk=resolve(process.env.MUTRACER_OIDN_ROOT??resolve(cache,name));
  const sourceLibs=resolve(sdk,win?'bin':'lib');
  const apiName=mac?'libOpenImageDenoise.2.dylib':win?'OpenImageDenoise.dll':'libOpenImageDenoise.so.2';
  function run(cmd,args){const r=spawnSync(cmd,args,{stdio:'inherit'});if(r.error||r.status)throw new Error(`${cmd} failed`);}
  if(process.env.MUTRACER_OIDN_ROOT&&!existsSync(resolve(sourceLibs,apiName)))throw new Error('MUTRACER_OIDN_ROOT does not contain the matching native OIDN SDK');
  if(!existsSync(resolve(sourceLibs,apiName))) {
    mkdirSync(cache,{recursive:true});
    const archive=resolve(cache,`${name}.${extension}`);
    if(!existsSync(archive))run('curl',['-LfsS','--retry','2',`https://github.com/RenderKit/oidn/releases/download/v${version}/${name}.${extension}`,'-o',archive]);
    if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==expected)throw new Error('OIDN SDK checksum mismatch');
    run('tar',[win?'-xf':'-xzf',archive,'-C',cache]);
  }
  const required=mac?['libOpenImageDenoise_core.2.5.1.dylib','libOpenImageDenoise_device_cpu.2.5.1.dylib','libOpenImageDenoise_device_metal.2.5.1.dylib']:
    win?['OpenImageDenoise_core.dll','OpenImageDenoise_device_cpu.dll']:['libOpenImageDenoise_core.so.2.5.1','libOpenImageDenoise_device_cpu.so.2.5.1'];
  for(const name of required)if(!existsSync(resolve(sourceLibs,name)))throw new Error('The no-large core requires the matching OIDN 2.5.1 platform SDK');
  const slim=buildOIDNCore(out);
  const libs=mac?resolve(contents,'Frameworks'):contents;
  const notices=resolve(contents,mac?'Resources/licenses/OIDN':'licenses/OIDN');
  mkdirSync(libs,{recursive:true});mkdirSync(notices,{recursive:true});
  const libraryFile=mac? /\.dylib$/ :win?/\.dll$/i:/\.so(?:\.\d+)*$/;
  for(const name of readdirSync(sourceLibs).filter(n=>libraryFile.test(n)&&
    (mac||/^(?:lib)?(?:OpenImageDenoise(?:_core|_device_cpu)?|tbb[^.]*)\./i.test(n)))) {
    const target=resolve(libs,`.${name}.build`);
    const source=/^(?:lib)?OpenImageDenoise_core\./.test(name)?slim.core:
      /^(?:lib)?OpenImageDenoise\./.test(name)?slim.api:resolve(sourceLibs,name);
    copyFileSync(source,target);
    if(mac&&name.startsWith('libOpenImageDenoise')) {
      const info=spawnSync('/usr/bin/otool',['-l',target],{encoding:'utf8'});
      if(info.status)throw new Error('Could not inspect OIDN loader paths');
      const paths=[...info.stdout.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g)].map(m=>m[1]);
      for(const path of paths)run('/usr/bin/install_name_tool',['-delete_rpath',path,target]);
      run('/usr/bin/install_name_tool',['-add_rpath','@loader_path',target]);
    }
    if(mac)run('/usr/bin/codesign',['--force','--sign','-',target]);
    if(!mac&&!win)run('patchelf',['--set-rpath','$ORIGIN',target]);
    renameSync(target,resolve(libs,name));
  }
  writeFileSync(resolve(notices,'MUTRACER-MODIFICATIONS.txt'),'OIDN 2.5.1 core/API rebuilt from commit 6602ee2ca38a1a2a02135beed8f6e68eed630180.\nMuTracer omits rt_alb_large, rt_hdr_calb_cnrm_large and rt_nrm_large weights.\nDevice modules remain from the official matching SDK; macOS/Linux loader paths are made relative to the bundled libraries.\n');
  for(const name of ['LICENSE.txt','third-party-programs.txt','third-party-programs-DPCPP.txt','third-party-programs-oneTBB.txt'])copyFileSync(resolve(sdk,'doc',name),resolve(notices,name));
}
