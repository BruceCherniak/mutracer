// Own the MuTracer SDK's dylib identity after Cargo links dependencies. The
// oidn-webgpu-native 0.1.1 build output propagates its install_name to consumers.
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
export function finalizeHostLibrary(target) {
  if(process.platform!=='darwin')return;
  const name='libmutracer_native_probe.dylib',library=resolve(target,'release',name);
  const run=(command,args)=>{
    const result=spawnSync(command,args,{encoding:'utf8'});
    if(result.error||result.status!==0)throw result.error??Error(`${command}: ${result.stderr}`);
    return result.stdout;
  };
  run('/usr/bin/install_name_tool',['-id',`@rpath/${name}`,library]);
  // Editing Mach-O load commands invalidates its linker-generated signature.
  run('/usr/bin/codesign',['--force','--sign','-',library]);
  if(run('/usr/bin/otool',['-D',library]).trim().split('\n').at(-1)!==`@rpath/${name}`)
    throw Error('MuTracer SDK dynamic library identity was not preserved');
}
