// wgpu's DX12 backend needs the same shader compiler in CI and the shipped app.
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeTar} from './platform.mjs';

export function prepareDxc() {
  const cache=resolve(tmpdir(),'mutracer-dxc-v1.8.2505.1'),archive=resolve(cache,'dxc_2025_07_14.zip');
  mkdirSync(cache,{recursive:true});
  function run(command,args) {
    const result=spawnSync(command,args,{stdio:'inherit'});
    if(result.error||result.status!==0)throw result.error??new Error(`${command} failed: ${result.status}`);
  }
  if(!existsSync(archive))run('curl',['-LfsS','--retry','2',
    'https://github.com/microsoft/DirectXShaderCompiler/releases/download/v1.8.2505.1/dxc_2025_07_14.zip','-o',archive]);
  if(createHash('sha256').update(readFileSync(archive)).digest('hex')!=='9ad895a6b039e3a8f8c22a1009f866800b840a74b50db9218d13319e215ea8a4')throw new Error('DXC checksum mismatch');
  if(!existsSync(resolve(cache,'bin/x64/dxcompiler.dll')))run(nativeTar,['-xf',archive,'-C',cache]);
  for(const name of ['dxcompiler.dll','dxil.dll'])if(!existsSync(resolve(cache,'bin/x64',name)))throw new Error(`DXC missing ${name}`);
  return cache;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(resolve(prepareDxc(),'bin/x64'));
