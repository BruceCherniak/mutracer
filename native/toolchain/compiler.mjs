import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {chmodSync,statSync} from 'node:fs';
const require=createRequire(import.meta.url);
const target=process.platform==='darwin'&&['arm64','x64'].includes(process.arch)?`darwin-${process.arch}`:
  process.platform==='linux'&&process.arch==='x64'?'linux-x64-gnu':
  process.platform==='win32'&&process.arch==='x64'?'win32-x64-msvc':null;
if(!target)throw Error(`Unsupported native compiler platform: ${process.platform}/${process.arch}`);
const manifest=require.resolve(`@scriptc/cli-${target}/package.json`);
const suffix=process.platform==='win32'?'.exe':'';
const binary=resolve(dirname(manifest),`dist/bin/scriptc${suffix}`);
// Platform archives carry the executable as data; the CLI wrapper normally
// supplies this installation step. Keep it local to the isolated toolchain.
if(process.platform!=='win32')for(const path of [binary,resolve(dirname(manifest),'dist/lib/typescript/lib/tsc'),
  resolve(dirname(manifest),'dist/lib/llvm/bin/scriptc-llvm-codegen'),
  resolve(dirname(manifest),'dist/lib/scriptc-comptime')])chmodSync(path,statSync(path).mode|0o111);
process.stdout.write(binary);
