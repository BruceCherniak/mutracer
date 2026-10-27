import {afterEach, describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {checkDxVersion, subsecondVersion, viewerDevOptions} from '../../native/scripts/viewer-dev.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, {recursive: true, force: true})));

describe('native viewer development command', () => {
  it('preserves model paths containing spaces without dx argument splitting', () => {
    const cwd = resolve('workspace');
    const options = viewerDevOptions(['--port', '9012', 'models/材质 spheres.glb'], {
      MUTRACER_DX: 'custom dx', MUTRACER_NATIVE_OUTPUT: 'output', CARGO_TARGET_DIR: 'viewer-cache',
    }, cwd);
    expect(options.env.MUTRACER_VIEWER_DEV_MODEL).toBe(resolve(cwd, 'models/材质 spheres.glb'));
    expect(options.command).toBe('custom dx');
    expect(options.out).toBe(resolve(cwd, 'output'));
    expect(options.env.CARGO_TARGET_DIR).toBe(resolve(cwd, 'viewer-cache'));
    expect(options.args).toContain('--locked');
    expect(options.args).toContain('--hot-patch');
    expect(options.args.slice(-2)).toEqual(['--port', '9012']);
    expect(options.args).not.toContain('--args');
  });

  it('starts with the default model and a separate dev target when no model is passed', () => {
    const environment = {MUTRACER_VIEWER_DEV_MODEL: 'stale.glb'};
    const options = viewerDevOptions([], environment);
    expect(options.env.MUTRACER_VIEWER_DEV_MODEL).toBeUndefined();
    expect(environment.MUTRACER_VIEWER_DEV_MODEL).toBe('stale.glb');
    expect(options.target).toBe(resolve(options.out, 'cargo-target'));
    expect(options.out).toMatch(/viewer-dev$/);
  });

  it('resolves relative dx paths before switching to the viewer directory', () => {
    const cwd = resolve('workspace');
    expect(viewerDevOptions([], {MUTRACER_DX: './tools/dx'}, cwd).command).toBe(resolve(cwd, 'tools/dx'));
  });

  it.each(['0', '-1', '65536', '1.2', '1e3', 'port'])('rejects invalid port %s', port => {
    expect(() => viewerDevOptions([`--port=${port}`])).toThrow('--port must be an integer');
  });

  it('rejects ambiguous multiple startup models', () => {
    expect(() => viewerDevOptions(['first.glb', 'second.glb'])).toThrow('at most one');
  });

  it('shows help without an installed dx or native toolchain', () => {
    const result = spawnSync(process.execPath, ['native/scripts/viewer-dev.mjs', '--help'], {
      encoding: 'utf8', env: {...process.env, MUTRACER_DX: 'missing-dx'},
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('npm run native:viewer:dev');
    expect(result.stdout).toContain(`dx ${subsecondVersion}`);
  });

  it('fails before preparing AOT or GPU resources when dx cannot run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutracer-viewer-dev-test-'));
    temporary.push(directory);
    const out = join(directory, 'output');
    const result = spawnSync(process.execPath, ['native/scripts/viewer-dev.mjs'], {
      encoding: 'utf8', env: {...process.env, MUTRACER_DX: join(directory, 'missing-dx'), MUTRACER_NATIVE_OUTPUT: out},
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`cargo install dioxus-cli --version ${subsecondVersion} --locked`);
    expect(existsSync(out)).toBe(false);
  });

  it('rejects a runnable tool that does not report the matching dx protocol version', () => {
    expect(() => checkDxVersion(process.execPath, process.env)).toThrow(`requires dx ${subsecondVersion}`);
  });
});
