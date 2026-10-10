import sobol from './sobol.glsl.js';
import { createShaderMixin, glsl, Shader } from '../../shader.js';

export default createShaderMixin({
  uniforms: {
    samplingPattern: Shader.uniform('int', 0),
    sequenceSeed: Shader.uniform('int', 0),
    zSobolLogSPP: Shader.uniform('int', 0)
  },
  main: glsl`

${sobol}

void initRandom() {
  samplingPixel = uvec2(v_Texcoord / pixelSize);
  pixelSampleIndex = uint(sampleCount);
  samplingBounce = 0u; hashedCounter = 0u;
}

vec2 pixelJitter() {
  if (samplingPattern == 0 || samplingPattern == 1) {
    return (sample2D(CAMERA_PIXEL) - 0.5) * pixelSize;
  }
  return jitter;
}
`
});
