import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {nativeToolchainEnv} from '../scripts/platform.mjs';
import {patchWindowsObject} from '../scripts/windows-msvc-archive.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT,'windows-msvc-runtime');
mkdirSync(out,{recursive:true});
// A real x64 COFF leaf constructor tail-calls the C host's mt_mark_ctor. Keeping
// it in GNU .ctors initially verifies that the conversion actually runs in UCRT.
const strings=Buffer.from('\0\0\0\0mt_test_ctor\0mt_mark_ctor\0');strings.writeUInt32LE(strings.length);
const bytes=Buffer.alloc(172+strings.length);
bytes.writeUInt16LE(0x8664,0);bytes.writeUInt16LE(2,2);bytes.writeUInt32LE(136,8);bytes.writeUInt32LE(2,12);
const section=(at,name,size,data,reloc,flags)=>{bytes.write(name,at);bytes.writeUInt32LE(size,at+16);bytes.writeUInt32LE(data,at+20);bytes.writeUInt32LE(reloc,at+24);bytes.writeUInt16LE(1,at+32);bytes.writeUInt32LE(flags,at+36);};
section(20,'.text',5,100,116,0x60500020);section(60,'.ctors',8,108,126,0xc0400040);
bytes[100]=0xe9;bytes.writeUInt32LE(1,116);bytes.writeUInt32LE(1,120);bytes.writeUInt16LE(4,124);
bytes.writeUInt16LE(1,134); // ctor ADDR64 relocation points at symbol zero.
bytes.writeUInt32LE(4,140);bytes.writeInt16LE(1,148);bytes.writeUInt16LE(0x20,150);bytes[152]=2;
bytes.writeUInt32LE(17,158);bytes.writeUInt16LE(0x20,168);bytes[170]=2;
strings.copy(bytes,172);
const changed=patchWindowsObject(bytes);if(changed.constructors!==1)throw Error('Missing constructor fixture');
const object=resolve(out,'constructor.obj');writeFileSync(object,bytes);
const env=nativeToolchainEnv();
const run=(name,command,args,options={})=>{
 const result=spawnSync(command,args,{cwd:out,env,encoding:'utf8',timeout:120000,...options});
 writeFileSync(resolve(out,name+'.log'),(result.stdout??'')+(result.stderr??''));
 if(result.error||result.status!==0)throw result.error??Error(`${name}: ${result.stdout}${result.stderr}`);
};
const binary=resolve(out,'runtime-contract.exe');
run('build',env.CC??'cl.exe',['/nologo','/std:c11','/MD','/O2','/W3','/WX','/D_CRT_SECURE_NO_WARNINGS',
 resolve(root,'native/host/windows-msvc-compat.c'),resolve(root,'native/tests/windows-msvc-runtime.c'),object,'/Fe'+binary]);
run('runtime',binary,[]);
writeFileSync(resolve(out,'summary.json'),JSON.stringify({passed:true,crt:'MSVC/UCRT',constructors:true,formatting:true,unicodeFilesystem:true,divisionCases:53},null,2)+'\n');
console.log('PASS MSVC runtime/constructor contract');
