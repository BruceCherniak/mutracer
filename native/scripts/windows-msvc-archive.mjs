// Adapt only the generated archive, keeping scriptc's verified runtime pack intact.
// COFF layout: https://learn.microsoft.com/windows/win32/debug/pe-format
import {readFileSync,writeFileSync,renameSync,existsSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {nativeToolchainEnv} from './platform.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

const aliases=Object.freeze({___chkstk_ms:'__chkstk','.ctors':'.CRT$XCU',
      __local_stdio_printf_options:'mt_stdio_printf_options',_fstat64i32:'mt_fstat',
      __mingw_printf:'mt_printf',__mingw_fprintf:'mt_fprintf',__mingw_snprintf:'mt_snprintf',
      __mingw_vsnprintf:'mt_vsnprintf',__mingw_strtod:'mt_strtod',__udivti3:'mt_udiv',
      opendir:'mt_odir',readdir:'mt_rdir',closedir:'mt_cdir',truncate:'mt_trunc',stat64i32:'mt_stat'});


export function patchWindowsObject(object) {
  // AMD64 COFF and bigobj use the same section headers but different symbols.
  let header,sections,symbols,count,stride;
  if(object.length>=20&&object.readUInt16LE(0)===0x8664) {
    header=20+object.readUInt16LE(16);sections=object.readUInt16LE(2);
    symbols=object.readUInt32LE(8);count=object.readUInt32LE(12);stride=18;
  }else if(object.length>=56&&object.readUInt32LE(0)===0xffff0000&&object.readUInt16LE(4)>=2&&object.readUInt16LE(6)===0x8664) {
    header=56;sections=object.readUInt32LE(44);symbols=object.readUInt32LE(48);count=object.readUInt32LE(52);stride=20;
  }else return {constructors:0,probes:0}; // ar indexes/import members are not COFF objects.
  if(header+sections*40>object.length||symbols+count*stride>object.length)throw Error('Invalid scriptc COFF object');
  let constructors=0,probes=0;
  for(let section=0;section<sections;section++) {
    const at=header+section*40,name=object.subarray(at,at+8).toString('ascii').replace(/\0.*$/,'');
    if(name!=='.ctors')continue;
    if(object.readUInt32LE(at+16)%8)throw Error('Invalid x64 constructor array');
    object.write('.CRT$XCU',at,8,'ascii');
    // CRT initializer arrays belong in read-only initialized data.
    object.writeUInt32LE((object.readUInt32LE(at+36)&0x7fffffff)>>>0,at+36);
    constructors++;
  }
  const strings=symbols+count*stride;
  for(let symbol=0;symbol<count;) {
    const at=symbols+symbol*stride;
    let nameAt=at,capacity=8;
    if(object.readUInt32LE(at)===0) {
      nameAt=strings+object.readUInt32LE(at+4);
      if(nameAt>=object.length)throw Error('Invalid COFF symbol name');
      const end=object.indexOf(0,nameAt);if(end<0)throw Error('Unterminated COFF symbol');capacity=end-nameAt;
    }
    const name=object.subarray(nameAt,nameAt+capacity).toString('ascii').replace(/\0.*$/,'');
    const renamed=Object.hasOwn(aliases,name)?aliases[name]:undefined;
    if(renamed) {
      if(renamed.length>capacity)throw Error('Unexpected COFF symbol size');
      object.fill(0,nameAt,nameAt+capacity);object.write(renamed,nameAt,renamed.length,'ascii');
      if(name==='___chkstk_ms')probes++;
    }
    symbol+=1+object[at+stride-1];
  }
  return {constructors,probes};
}

export function patchWindowsArchive(bytes) {
  if(bytes.subarray(0,8).toString()!=='!<arch>\n')throw Error('Expected a scriptc archive');
  let at=8,constructors=0,probes=0;
  while(at<bytes.length) {
    if(at+60>bytes.length||bytes.subarray(at+58,at+60).toString()!=='`\n')throw Error('Invalid ar member');
    const length=Number(bytes.subarray(at+48,at+58).toString().trim());
    if(!Number.isSafeInteger(length)||length<0||at+60+length>bytes.length)throw Error('Invalid ar member size');
    const changed=patchWindowsObject(bytes.subarray(at+60,at+60+length));
    constructors+=changed.constructors;probes+=changed.probes;
    at+=60+length+(length&1);
  }
  return {constructors,probes};
}

export function normalizeWindowsArchive(archive,options={}) {
  const env=nativeToolchainEnv(options.env??process.env);
  const run=(command,args)=>{
    const result=spawnSync(command,args,{...options,cwd:root,env,encoding:'utf8'});
    if(result.error||result.status!==0)throw result.error??Error(`${command}: ${result.stdout??''}${result.stderr??''}`);
  };
  const bytes=readFileSync(archive);patchWindowsArchive(bytes);
  const normalized=archive+'.coff.lib';writeFileSync(normalized,bytes);
  const source=resolve(root,'native/host/windows-msvc-compat.c');
  const object=resolve(dirname(archive),'windows-msvc-compat.obj');
  const stamp=object+'.sha256',hash=createHash('sha256').update(readFileSync(source)).digest('hex');
  if(!existsSync(object)||!existsSync(stamp)||readFileSync(stamp,'utf8')!==hash) {
    run(env.CC??'cl.exe',['/nologo','/c','/std:c11','/MD','/O2','/W3','/WX','/D_CRT_SECURE_NO_WARNINGS',source,`/Fo${object}`]);
    writeFileSync(stamp,hash);
  }
  const staged=archive+'.msvc.lib';
  run('lib.exe',['/nologo',`/OUT:${staged}`,normalized,object]);
  renameSync(staged,archive);rmSync(normalized);
}
