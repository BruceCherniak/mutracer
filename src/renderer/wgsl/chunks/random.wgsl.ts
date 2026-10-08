export default /*wgsl*/ `

// Every time we call randomSample() in the shader, and for every call to render,
// we want that specific bit of the shader to fetch a sample from the same position in stratifiedSamples
// This allows us to use stratified sampling for each random variable in our path tracing
var<private> sampleIndex : i32 = 0;

var<private> pixelSeed: f32;

// fn initRandom() {
  // const highp float a = 12.9898, b = 78.233, c = 43758.5453;
  // highp float dt = dot(v_Texcoord + vec2(sampleCount / 10000.0, sampleCount / 10000.0 + 0.1), vec2(a,b)), sn = mod(dt, 3.141592653589793);
  // pixelSeed = fract(sin(sn) * c);
  // tile the small noise texture across the entire screen
// }

fn randomSample() -> f32 {
  if (USE_STRATIFIED_SAMPLING) {
    let i2 = sampleIndex % SAMPLING_DIMENSIONS;
    let stratifiedSample = stratifiedSamples[i2].x;
    let random = fract((stratifiedSample + pixelSeed) * rtUniform.strataSize); // blue noise + stratified samples
    sampleIndex += 1;
    // transform random number between [0, 1] to (0, 1)
    return EPS + (1.0 - 2.0 * EPS) * random;
  }
  else {
    return EPS + rand() * (1.0 - 2.0 * EPS);
  }
}
`;
