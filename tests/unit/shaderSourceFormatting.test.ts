import {afterEach, describe, expect, it, vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {shaderSourceLoader, shaderIdentifierMap, stripShaderFormatting} from './shaderSourceLoader';
import {renameShaderIdentifiers} from '../../scripts/shader-identifiers.mjs';
import {makeRayTraceUniform} from '../../src/renderer/WGPURayTracePass';
import {WGPU_SCENE_FEATURE_BITS, wgpuSceneFeatureFlags} from '../../src/renderer/WGPUSceneFeatures';

const original = shaderSourceLoader(false);
const stripped = shaderSourceLoader(true);
const rayTrace = original('src/renderer/wgsl/rayTrace.compute.ts').default;
const compactRayTrace = stripped('src/renderer/wgsl/rayTrace.compute.ts').default;
const originalNames = new Map([...shaderIdentifierMap].map(([name, compact]) => [compact, name]));
const tokens = (source: string) => stripShaderFormatting(renameShaderIdentifiers(source, originalNames)).match(/[A-Za-z_][\w]*|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?[uifh]?|>>|<<|&&|\|\||!=|==|<=|>=|\+\+|--|\S/g);
afterEach(() => { vi.unstubAllGlobals(); });

function gpu() {
  vi.stubGlobal('GPUBufferUsage', {UNIFORM: 1, COPY_DST: 2});
  vi.stubGlobal('GPUShaderStage', {VERTEX: 1, FRAGMENT: 2, COMPUTE: 4});
  return {createBuffer: (descriptor: GPUBufferDescriptor) => ({size: descriptor.size}), queue: {writeBuffer() {}}, createSampler: () => ({})} as unknown as GPUDevice;
}

describe('shader generation independent of source formatting', () => {
  it('preserves tokens, entry points and uniform contracts for every BLAS mask and structural variant', () => {
    gpu();
    for (let blasLayoutMask = 0; blasLayoutMask < 16; blasLayoutMask++) {
      for (const hasDisplacement of [false, true]) for (const hasAlpha of [false, true]) for (const hasSceneAlpha of [false, true]) {
        const options = {hasDisplacement, hasAlpha, hasSceneAlpha, blasLayoutMask};
        const source = rayTrace(options);
        const compact = compactRayTrace(options);
        expect(tokens(compact)).toEqual(tokens(source));
        // No selected name may be left behind by a dynamic code path.
        expect(renameShaderIdentifiers(compact, shaderIdentifierMap)).toBe(compact);
        const parsed = makeShaderDataDefinitions(compact);
        expect(Object.keys(parsed.entryPoints).sort()).toEqual(['depthQuery', 'main']);
        const {buffer, views} = makeRayTraceUniform();
        expect(parsed.uniforms.rtUniform.size).toBe(buffer.byteLength);
        for (const [name, view] of Object.entries(views)) expect(parsed.structs.RayTraceUniform.fields[name]?.offset, name).toBe(view.byteOffset);
        expect(views.loopUnrollGuard[0]).toBe(4);
      }
    }
  }, 30000);

  it('keeps all runtime flags addressable in the same shader, including combinations', () => {
    gpu();
    const source = compactRayTrace({hasDisplacement: false, blasLayoutMask: 15});
    const sourceTokens = tokens(source)?.join(' ') ?? '';
    const names = Object.keys(WGPU_SCENE_FEATURE_BITS);
    const combinations = [0, 2 ** names.length - 1, ...names.map(name => WGPU_SCENE_FEATURE_BITS[name]),
      wgpuSceneFeatureFlags({HAS_THIN_FILM: true, HAS_COAT: true}),
      wgpuSceneFeatureFlags({HAS_FUZZ: true, HAS_SUBSURFACE: true, USE_DIFFUSE_MAPS: true})];
    for (const sceneFlags of combinations) for (let backgroundFlags = 0; backgroundFlags < 8; backgroundFlags++) {
      const {views} = makeRayTraceUniform();
      views.sceneFeatureFlags[0] = sceneFlags; views.backgroundFlags[0] = backgroundFlags;
      for (const bit of Object.values(WGPU_SCENE_FEATURE_BITS)) {
        expect(!!(views.sceneFeatureFlags[0] & bit)).toBe(!!(sceneFlags & bit));
      }
      for (const bit of [1, 2, 4]) expect(!!(views.backgroundFlags[0] & bit)).toBe(!!(backgroundFlags & bit));
    }
    // Feature/material specialization intentionally retains its existing form.
    for (const name of ['HAS_THIN_FILM', 'HAS_COAT', 'HAS_FUZZ', 'HAS_SUBSURFACE', 'USE_DIFFUSE_MAPS', 'USE_NORMAL_MAPS']) {
      const bit = WGPU_SCENE_FEATURE_BITS[name];
      expect(sourceTokens.includes(`rtUniform . sceneFeatureFlags & ${bit}u`), name).toBe(true);
    }
    for (const bit of [1, 2, 4]) expect(sourceTokens.includes(`rtUniform . backgroundFlags & ${bit}`)).toBe(true);

  });

  it.each([false, true])('generates and parses explicit WGSL sampling wrappers (scratch=%s)', scratch => {
    const device = gpu();
    const code = (loader: ReturnType<typeof shaderSourceLoader>) => {
      const {WGPUFullQuadPass} = loader('src/renderer/WGPUFullQuadPass.ts');
      const compose = loader('src/renderer/wgsl/compose.frag.wgsl.ts');
      const pass = new WGPUFullQuadPass('formatting', device, {
        inputs: ['colorTex', 'bloomTex', 'flatBackgroundMaskTex', 'foregroundTex', 'catcherBackgroundTex', 'shadowCatcherTex'],
        outputs: ['color', 'denoiseColor'], samplers: {linearSampler: {}},
        fsDefine: compose.composeDefine,
        fsMain: compose.composeMain + compose.compositeDenoiseOutputMain
      });
      if (scratch) pass.reserveCapacity();
      return pass._getFullFs();
    };
    const source = code(original), compact = code(stripped);
    expect(tokens(compact)).toEqual(tokens(source));
    const parsed = makeShaderDataDefinitions(compact);
    expect(Object.keys(parsed.entryPoints)).toEqual(['main']);
    expect('imageRegions' in parsed.uniforms).toBe(scratch);
    expect(compact).toContain('fn colorTexRegion()');
    expect(compact).toContain('fn load_colorTex(');
    expect(compact).toContain('fn sample_colorTex_linearSampler(');
  });

  it.each([false, true])('preserves and parses every bloom pass including sampled textures (scratch=%s)', scratch => {
    const device = gpu();
    function codes(loader: ReturnType<typeof shaderSourceLoader>) {
      const Bloom = loader('src/renderer/WGPUBloomPass.ts').default;
      const bloom = new Bloom(device);
      if (scratch) bloom.reserveCapacity();
      return [bloom._brightPass, ...bloom._downsamplePasses, ...bloom._blurHPasses, ...bloom._blurVPasses, ...bloom._blendPasses]
        .map(pass => pass._getFullFs() as string);
    }
    const source = codes(original), compact = codes(stripped);
    for (let i = 0; i < source.length; i++) {
      expect(tokens(compact[i])).toEqual(tokens(source[i]));
      expect(Object.keys(makeShaderDataDefinitions(compact[i]).entryPoints)).toEqual(['main']);
    }
    expect(compact[1].includes('sample_colorTex_linearSampler(uv2')).toBe(true);
  });

  it.each([false, true])('preserves explicit GLSL sampling and region selection (scratch=%s)', scratch => {
    function code(loader: ReturnType<typeof shaderSourceLoader>) {
      const {WebGLFullQuadPass} = loader('src/renderer/WebGLFullQuadPass.ts');
      const {brightFragment} = loader('src/renderer/glsl/webglPipeline.frag.ts');
      const pass = new WebGLFullQuadPass('formatting', {}, {shader: brightFragment});
      if (scratch) pass.reserveCapacity();
      const shader = pass._bindings.shader;
      return {source: shader.functions.map((fn: () => string) => fn()).join('\n') + shader.main, uniforms: shader.uniforms};
    }
    const source = code(original), compact = code(stripped);
    expect(tokens(compact.source)).toEqual(tokens(source.source));
    expect('colorTexRegionSize' in compact.uniforms).toBe(scratch);
    expect(compact.source).toContain('ivec2 colorTexRegion()');
    expect(compact.source).toContain('sample_colorTex(');
  });
});
