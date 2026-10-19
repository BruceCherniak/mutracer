import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {chmodSync,statSync} from 'node:fs';
const require=createRequire(import.meta.url);
if(process.platform!=='darwin'||!['arm64','x64'].includes(process.arch))throw Error('The native CI toolchain currently supports macOS arm64/x64.');
const manifest=require.resolve(`@scriptc/cli-darwin-${process.arch}/package.json`);
const binary=resolve(dirname(manifest),'dist/bin/scriptc');
// Platform archives carry the executable as data; the CLI wrapper normally
// supplies this installation step. Keep it local to the isolated toolchain.
for(const path of [binary,resolve(dirname(manifest),'dist/lib/typescript/lib/tsc'),
  resolve(dirname(manifest),'dist/lib/llvm/bin/scriptc-llvm-codegen'),
  resolve(dirname(manifest),'dist/lib/scriptc-comptime')])chmodSync(path,statSync(path).mode|0o111);
process.stdout.write(binary);
