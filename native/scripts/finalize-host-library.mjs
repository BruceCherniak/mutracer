// Own the MuTracer SDK's dynamic-library identity after Cargo links dependencies.
// oidn-webgpu-native 0.1.1 build output propagates its SONAME/install_name.
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
export function finalizeHostLibrary(target) {
  if(!['darwin','linux'].includes(process.platform))return;
  const mac=process.platform==='darwin';
  const name='libmutracer_native_probe.'+(mac?'dylib':'so'),library=resolve(target,'release',name);
  const run=(command,args)=>{
    const result=spawnSync(command,args,{encoding:'utf8'});
    if(result.error||result.status!==0)throw result.error??Error(`${command}: ${result.stderr}`);
    return result.stdout;
  };
  if(mac) {
    run('/usr/bin/install_name_tool',['-id',`@rpath/${name}`,library]);
    // Editing Mach-O load commands invalidates its linker-generated signature.
    run('/usr/bin/codesign',['--force','--sign','-',library]);
    if(run('/usr/bin/otool',['-D',library]).trim().split('\n').at(-1)!==`@rpath/${name}`)
      throw Error('MuTracer SDK dynamic library identity was not preserved');
  }else {
    run('patchelf',['--set-soname',name,library]);
    if(run('patchelf',['--print-soname',library]).trim()!==name)
      throw Error('MuTracer SDK ELF SONAME was not preserved');
  }
}
