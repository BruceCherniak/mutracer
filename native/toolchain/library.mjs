// scriptc 0.4.2's native compiler throws an internal union-narrowing error
// during LLVM emission for several library graphs on macOS arm64. Its Node compiler
// emits those same graphs successfully, using the matching LLVM/runtime packs.
import {compileLibrary} from '@scriptc/compiler';
import {runCli} from '@scriptc/compiler/cli/command';

const args = process.argv.slice(2);
if (args[0] !== 'build' || !args.includes('--lib'))
  throw new Error('The Node compiler adapter only supports library builds.');
process.exitCode = await runCli(args, {compileLibrary});
