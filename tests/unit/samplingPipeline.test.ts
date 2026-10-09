import { expect, it } from 'vitest';
import WGPURayTracePass, { makeRayTraceUniform } from '../../src/renderer/WGPURayTracePass';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass';
import type { SamplingPattern } from '../../src/renderer/sampling';

it.each(['sobol','zsobol','random'] as SamplingPattern[])(
  'both backends track pattern %s and restart only for sequence changes', pattern => {
    const gpu: any = Object.create(WGPURayTracePass.prototype);
    gpu._constants = { SAMPLING_PATTERN: -1 };
    gpu._rtUniform = makeRayTraceUniform();
    const uniforms = new Map();
    const gl: any = Object.create(WebGLRayTracePass.prototype);
    gl._tracePasses = [{setDefines() {}, setUniform(k: string,v: number){uniforms.set(k,v);}}];
    gl._samplingCode = -1;
    for (const pass of [gpu,gl]) {
      expect(pass.setSamplingPattern(pattern,64,0)).toBe(true);
      expect(pass.setSamplingPattern(pattern,64,0)).toBe(false);
      expect(pass.setSamplingPattern(pattern,64,12)).toBe(true);
      expect(pass.setSamplingPattern(pattern,128,12)).toBe(pattern.startsWith('zsobol'));
    }
    expect(gpu._rtUniform.views.sequenceSeed[0]).toBe(uniforms.get('sequenceSeed'));
    expect(gpu._rtUniform.views.zSobolLogSPP[0]).toBe(uniforms.get('zSobolLogSPP'));
    gpu.setSampleSequenceOffset(77);
    expect(gpu._rtUniform.views.sampleSequenceOffset[0]).toBe(77);
  }
);

it('public ZSobol plans the remaining budget after its independent first sample', () => {
  const gpu: any = Object.create(WGPURayTracePass.prototype);
  gpu._constants = { SAMPLING_PATTERN: -1 };
  gpu._rtUniform = makeRayTraceUniform();
  const gl: any = Object.create(WebGLRayTracePass.prototype);
  const uniforms = new Map();
  gl._samplingCode = -1;
  gl._tracePasses = [{setDefines() {}, setUniform(k: string,v: number){uniforms.set(k,v);}}];
  for (const [budget,log] of [[1,0],[2,0],[3,1],[17,4],[18,5],[Infinity,16]]) {
    gpu.setSamplingPattern('zsobol',budget,0);
    gl.setSamplingPattern('zsobol',budget,0);
    expect(gpu._rtUniform.views.zSobolLogSPP[0]).toBe(log);
    expect(uniforms.get('zSobolLogSPP')).toBe(log);
  }
});

it.each(['stratified', 'zsobol-camera', 'zsobol-first', 'invalid'])(
  'both backends reject unsupported pattern %s before changing the sequence', pattern => {
    for (const Class of [WGPURayTracePass, WebGLRayTracePass]) {
      const pass: any = Object.create(Class.prototype);
      expect(() => pass.setSamplingPattern(pattern, 64, 0)).toThrow('Unknown sampling pattern');
    }
  }
);
