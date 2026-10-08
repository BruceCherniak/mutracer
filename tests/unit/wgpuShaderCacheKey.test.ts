import { describe, expect, it } from 'vitest';
import { shaderSourceFingerprint } from '../../src/renderer/WGPURayTracePass';

describe('WebGPU shader cache-key stability', () => {
  it('fingerprints exact WGSL text deterministically', () => {
    expect(shaderSourceFingerprint('fn main() {}')).toBe('9f731f0f');
    expect(shaderSourceFingerprint('fn main() {}'))
      .toBe(shaderSourceFingerprint('fn main() {}'));
    expect(shaderSourceFingerprint('fn main() {}'))
      .not.toBe(shaderSourceFingerprint('fn main(){ }'));
    expect(shaderSourceFingerprint('fn main() {}'))
      .not.toBe(shaderSourceFingerprint('// comment\nfn main() {}'));
  });
});
