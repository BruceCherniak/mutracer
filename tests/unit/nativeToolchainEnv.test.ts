import {expect, it} from 'vitest';
import {delimiter, resolve} from 'node:path';
import {nativeToolchainEnv, windows} from '../../native/scripts/platform.mjs';

it('preserves compiler discovery when a Windows Path environment is copied and extended', () => {
  const source = {Path: 'zig;gcc;node', KEEP: 'value'};
  const env = nativeToolchainEnv(source);
  if (windows) {
    expect(env.PATH).toBe(source.Path);
    expect(Object.keys(env).filter(key => key.toLowerCase() === 'path')).toEqual(['PATH']);
    env.PATH = 'release' + delimiter + env.PATH;
    expect(env.PATH).toContain(source.Path);
  } else expect(env).toEqual(source);
  expect(env.KEEP).toBe('value');
  expect(source).toEqual({Path: 'zig;gcc;node', KEEP: 'value'});
});

it('puts the MSVC linker ahead of Git Bash while retaining the supplied toolchain path', () => {
  const source = {Path: 'git;zig;gcc', VCToolsInstallDir: resolve('vc')};
  const env = nativeToolchainEnv(source);
  if (windows) {
    const tools = resolve(source.VCToolsInstallDir, 'bin/Hostx64/x64');
    expect(env.PATH).toBe(tools + delimiter + source.Path);
    expect(env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER).toBe(resolve(tools, 'link.exe'));
  } else expect(env).toEqual(source);
});
