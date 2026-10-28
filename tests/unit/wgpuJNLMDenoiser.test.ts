import { makeShaderDataDefinitions } from 'webgpu-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createJNLMFilterWGSL,
  jnlmGuideWGSL,
  jnlmVarianceWGSL
} from '../../src/renderer/WGPUJNLMDenoiser';
import { JNLM_DEFAULT_SHAPE } from '../../src/renderer/jnlm';
import {
  createJNLMLoadColorWGSL, jnlmEncodeWGSL, packJNLMParameters
} from '../../src/renderer/wgsl/jnlm.compute';

describe('JNLM denoiser shaders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('share the params layout packed by WGPUJNLMDenoisePass', () => {
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    for (const shader of [
      jnlmGuideWGSL,
      jnlmVarianceWGSL,
      createJNLMLoadColorWGSL(),
      createJNLMLoadColorWGSL('buffers'),
      createJNLMFilterWGSL(),
      createJNLMFilterWGSL(JNLM_DEFAULT_SHAPE, 'buffers'),
      createJNLMFilterWGSL({ ...JNLM_DEFAULT_SHAPE, patchRadius: 2, searchRadius: 7 })
    ]) {
      const definitions = makeShaderDataDefinitions(shader);
      expect(definitions.uniforms.params.size).toBe(16);
      // encode() writes size (u32 x 2) then the color sensitivity (f32).
      const { fields } = definitions.structs.JNLMParams;
      expect(fields.size.offset).toBe(0);
      expect(fields.colorSensitivity.offset).toBe(8);
    }
  });

  it('packs the same sample rows, sensitivity and pass spacing for both hosts', () => {
    for (const strength of [1, 2.5, 0.0001]) {
      for (let pass = 0; pass < 4; pass++) {
        const bytes = packJNLMParameters(31, 17, strength, pass);
        expect(bytes.byteLength).toBe(16);
        expect([...new Uint32Array(bytes, 0, 2)]).toEqual([31, 17]);
        expect([...new Float32Array(bytes, 8, 2)]).toEqual([
          Math.fround(0.6 * Math.max(strength, 0.001)), 2 ** pass
        ]);
      }
    }
  });

  it('keeps the native texture/buffer binding contract and output uniforms', () => {
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    const texture = makeShaderDataDefinitions(createJNLMFilterWGSL());
    const buffer = makeShaderDataDefinitions(createJNLMFilterWGSL(JNLM_DEFAULT_SHAPE, 'buffers'));
    for (const name of ['albedoTex', 'normalTex', 'shadowCatcherTex']) {
      expect(buffer.storages[name].binding).toBe(texture.textures[name].binding);
    }
    const prepare = makeShaderDataDefinitions(createJNLMLoadColorWGSL('buffers'));
    expect(prepare.storages.normalAccumulation.binding).toBe(3);
    expect(prepare.storages.normal.binding).toBe(4);
    expect(prepare.storages.shadowAccumulation.binding).toBe(5);
    expect(prepare.storages.shadow.binding).toBe(6);
    expect(prepare.textures.albedoTex.binding).toBe(7);
    expect(prepare.storages.albedo.binding).toBe(8);
    const encode = makeShaderDataDefinitions(jnlmEncodeWGSL);
    expect(encode.uniforms.params.size).toBe(16);
    expect(encode.storages.color.binding).toBe(1);
    expect(encode.storageTextures.output.binding).toBe(2);
  });
});
