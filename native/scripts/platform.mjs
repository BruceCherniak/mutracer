// Names at the native toolchain/OS boundary; renderer data stays platform-neutral.
import {delimiter,resolve} from 'node:path';
export const windows = process.platform === 'win32';
// Git Bash's GNU tar treats a Windows drive letter as a remote archive host.
export const nativeTar = windows ? resolve(process.env.SystemRoot??'C:\\Windows','System32/tar.exe') : 'tar';
export const executable = name => name + (windows ? '.exe' : '');
export const archiveName = name => name + (windows ? '.lib' : '.lib.a');
export const cCompiler = process.env.CC ?? (windows ? 'gcc' : 'cc');
export const cLinkFlags = windows
  ? ['-D_CRT_SECURE_NO_WARNINGS', '-lws2_32', '-lbcrypt', '-lcrypt32', '-liphlpapi', '-luserenv', '-lntdll', '-ladvapi32']
  : ['-lm'];

export function nativeToolchainEnv(environment=process.env) {
  const env={...environment};
  if(windows) {
    const path=Object.keys(env).find(key=>key.toLowerCase()==='path');
    const previous=path?env[path]:'';
    for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
    // Normalize Path even outside a Developer shell: object spreads lose
    // process.env's case-insensitive lookup before scripts prepend directories.
    env.PATH=previous;
    if(env.VCToolsInstallDir) {
      const tools=resolve(env.VCToolsInstallDir,'bin/Hostx64/x64');
      // Git Bash prepends its Unix link.exe; OIDN's CMake build needs MSVC.
      env.PATH=tools+delimiter+previous;
      env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER??=resolve(tools,'link.exe');
    }
  }
  return env;
}

export function viewerPlatform() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (windows && process.arch === 'x64') return 'windows-x64';
  throw new Error(`Unsupported native viewer platform: ${process.platform}/${process.arch}`);
}
