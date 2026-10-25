// App-local release CRT files from the installed Visual C++ toolchain.
// https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files
import {copyFileSync,existsSync,mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
export function bundleWindowsRuntime(bin,licenses,environment=process.env) {
  const redist=environment.VCToolsRedistDir;
  if(!redist)throw Error('Build from an x64 MSVC Developer environment with VCToolsRedistDir');
  const x64=resolve(redist,'x64');
  const folder=readdirSync(x64).filter(name=>/^Microsoft\.VC\d+\.CRT$/.test(name))
    .sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))[0];
  if(!folder)throw Error('Install the MSVC x64 release redistributable component');
  const source=resolve(x64,folder),files=readdirSync(source).filter(name=>/\.dll$/i.test(name));
  for(const required of ['msvcp140.dll','vcruntime140.dll'])if(!existsSync(resolve(source,required)))throw Error(`Missing MSVC runtime ${required}`);
  for(const name of files)copyFileSync(resolve(source,name),resolve(bin,name));
  const notices=resolve(licenses,'MSVC');mkdirSync(notices,{recursive:true});
  writeFileSync(resolve(notices,'RUNTIME.txt'),
    'Microsoft Visual C++ Runtime. Copyright Microsoft Corporation. All rights reserved.\n'+
    'Redistributed from the installed MSVC release redistributable under the Microsoft Software License Terms.\n'+
    'https://visualstudio.microsoft.com/license-terms/\n'+
    'https://learn.microsoft.com/visualstudio/releases/2022/redistribution\n'+
    `Component: ${folder}\nFiles: ${files.join(', ')}\n`);
}
