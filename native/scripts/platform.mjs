// Names at the native toolchain/OS boundary; renderer data stays platform-neutral.
export const windows = process.platform === 'win32';
export const executable = name => name + (windows ? '.exe' : '');
export const archiveName = name => name + (windows ? '.lib' : '.lib.a');
export const cCompiler = process.env.CC ?? (windows ? 'clang' : 'cc');
export const cLinkFlags = windows
  ? ['-D_CRT_SECURE_NO_WARNINGS', '-lws2_32', '-lbcrypt', '-lcrypt32', '-liphlpapi', '-luserenv', '-lntdll']
  : ['-lm'];

export function viewerPlatform() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (windows && process.arch === 'x64') return 'windows-x64';
  throw new Error(`Unsupported native viewer platform: ${process.platform}/${process.arch}`);
}
