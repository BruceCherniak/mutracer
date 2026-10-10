import { makeShaderDataDefinitions } from 'webgpu-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createJNLMFilterWGSL,
  jnlmGuideWGSL,
  jnlmVarianceWGSL
} from '../../src/renderer/WGPUJNLMDenoiser';
import { JNLM_DEFAULT_SHAPE } from '../../src/renderer/jnlm';

describe('JNLM denoiser shaders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('share the params layout packed by WGPUJNLMDenoisePass', () => {
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    for (const shader of [
      jnlmGuideWGSL,
      jnlmVarianceWGSL,
      createJNLMFilterWGSL(),
      createJNLMFilterWGSL({ ...JNLM_DEFAULT_SHAPE, patchRadius: 1, searchRadius: 7 })
    ]) {
      const definitions = makeShaderDataDefinitions(shader);
      expect(definitions.uniforms.params.size).toBe(16);
      // encode() writes size (u32 x 2) then the color sensitivity (f32).
      const { fields } = definitions.structs.JNLMParams;
      expect(fields.size.offset).toBe(0);
      expect(fields.colorSensitivity.offset).toBe(8);
    }
  });
});
