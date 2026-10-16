// Official pinned native SDK; binary payloads/cache never enter the repository.
import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,readdirSync,copyFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
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
  const libs=resolve(contents,'Frameworks'), notices=resolve(contents,'Resources/licenses/OIDN');
  mkdirSync(libs,{recursive:true});mkdirSync(notices,{recursive:true});
  for(const name of readdirSync(resolve(sdk,'lib')).filter(n=>n.endsWith('.dylib'))) {
    const target=resolve(libs,`.${name}.build`);copyFileSync(resolve(sdk,'lib',name),target);
    if(name.startsWith('libOpenImageDenoise'))run('/usr/bin/install_name_tool',['-rpath','@loader_path/../lib','@loader_path',target]);
    run('/usr/bin/codesign',['--force','--sign','-',target]);
    renameSync(target,resolve(libs,name));
  }
  for(const name of ['LICENSE.txt','third-party-programs.txt','third-party-programs-DPCPP.txt','third-party-programs-oneTBB.txt'])copyFileSync(resolve(sdk,'doc',name),resolve(notices,name));
}
