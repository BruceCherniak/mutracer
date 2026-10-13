import { describe, expect, it, vi } from 'vitest';
import WGPURayTracePass from '../../src/renderer/WGPURayTracePass';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass';
import { MAX_PATH_EVENTS, normalizeBounces } from '../../src/renderer/pathLimits';

describe('shared path depth normalization', () => {
  it.each([[0, 1], [-3, 1], [2.5, 3], [NaN, 1], [64, 20], [Infinity, 20], [-Infinity, 1],
    [1, 1], [3, 3], [6, 6], [7, 7], [20, 20]])('normalizes %s to %s in both backend setters and preview quality', (input, expected) => {
    expect(MAX_PATH_EVENTS).toBe(20);
    expect(normalizeBounces(input!)).toBe(expected);
    const gpu = Object.create(WGPURayTracePass.prototype) as any;
    gpu._bounces = -1;
    gpu._rtUniform = { views: { bounces: new Int32Array(1), bevel: new Int32Array(1),
      dispersionWavelengths: new Int32Array(1), directLightCandidates: new Int32Array(1) } };
    const gl = Object.create(WebGLRayTracePass.prototype) as any;
    gl._bounces = -1;
    const pass = { setUniform: vi.fn() };
    gl._tracePasses = [pass];
    expect(gpu.setBounce(input)).toBe(true);
    expect(gl.setBounce(input)).toBe(true);
    expect(gpu._bounces).toBe(expected);
    expect(gl._bounces).toBe(expected);
    expect(gpu.setBounce(input)).toBe(false);
    expect(gl.setBounce(input)).toBe(false);
    const quality = { bounces: input, bevel: false, dispersionWavelengths: 1, directLightCandidates: 4 };
    gpu.setQuality(quality);
    gl.setQuality(quality);
    expect(gpu._rtUniform.views.bounces[0]).toBe(expected);
    expect(pass.setUniform).toHaveBeenCalledWith('bounceLimit', expected);
  });
});
