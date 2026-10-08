// Noise texture used to generate a different random number for each pixel.
// We use blue noise in particular, but any type of noise will work.
import { createShaderMixin, glsl, Shader } from '../../shader';

export default createShaderMixin({
  uniforms: {
    noiseTex: Shader.uniform('sampler2D'),
    strataSize: Shader.uniform('float'),

    stratifiedSamples: Shader.arrayUniform('float', 'SAMPLING_DIMENSIONS')
  },
  main: glsl`

int sampleIndex = 0;
float pixelSeed;

void initRandom() {
  // IMPORTANT: we must initialize sampleIndex to 0 in the function.
  // Or in chrome it will be some fixed value(not sure which value it is).
  sampleIndex = 0;
  vec2 noiseSize = vec2(textureSize(noiseTex, 0));

  // tile the small noise texture across the entire screen
  pixelSeed = texture(noiseTex, v_Texcoord / (pixelSize * noiseSize)).r;
}

float randomSample() {
#ifdef USE_STRATIFIED_SAMPLING
  int i = sampleIndex % SAMPLING_DIMENSIONS;
  float stratifiedSample = stratifiedSamples[i];
  float random = fract((stratifiedSample + pixelSeed) * strataSize); // blue noise + stratified samples

  sampleIndex += 1;

  // transform random number between [0, 1] to (0, 1)
  return EPS + (1.0 - 2.0 * EPS) * random;
#else
  return EPS + rand() * (1.0 - 2.0 * EPS);
#endif
}

`
});
