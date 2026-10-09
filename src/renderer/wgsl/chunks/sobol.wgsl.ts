import { zSobolPackedPermutations, sobolD1Steps } from '../../sampling';
export default /* wgsl */ `
const CAMERA_PIXEL = 0u;
const CAMERA_LENS = 1u;
const CAMERA_WAVELENGTH = 2u;
const CAMERA_BEVEL_BASE = 3u;
const LIGHT_SELECT = 0u;
const LIGHT_POSITION = 1u;
const BSDF_LOBE = 2u;
const BSDF_DIRECTION = 3u;
const MEDIUM_CHANNEL = 4u;
const MEDIUM_DISTANCE = 5u;
const PHASE_DIRECTION = 6u;
const RUSSIAN_ROULETTE = 7u;
const BOUNCE_STRIDE = 64u;

// Burley 2020, Practical Hash-based Owen Scrambling, JCGT 9(4).
// ZSobol digit walk adapted from pbrt-v4 samplers.h (Apache-2.0).
var<private> samplingPixel: vec2u;
var<private> pixelSampleIndex: u32;
var<private> samplingBounce: u32 = 0u;
var<private> hashedCounter: u32 = 0u;
fn sampleHash(valueIn: u32) -> u32 {
  var x = valueIn;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  return x ^ (x >> 16u);
}
fn sampleSeed(a: u32, b: u32) -> u32 {
  return sampleHash(a ^ sampleHash(b + 0x9e3779b9u));
}
fn lkPermute(valueIn: u32, seed: u32) -> u32 {
  var x = valueIn + seed;
  x ^= x * 0x6c50b47cu; x ^= x * 0xb82f1e52u;
  x ^= x * 0xc7afe638u; x ^= x * 0x8d22f6e6u;
  return x;
}
fn owen(x: u32, seed: u32) -> u32 {
  return reverseBits(lkPermute(reverseBits(x), seed));
}
// Parallel XOR butterfly equals v ^= v >> 1 for all 32 direction bits.
fn sobolD1(valueIn: u32) -> u32 {
  var r = reverseBits(valueIn);
  ${sobolD1Steps.map(([shift, mask]) => `r ^= (r << ${shift}u) & 0x${mask.toString(16)}u;`).join("\n  ")}
  return r;
}
fn sobol2D(index: u32, seed: u32) -> vec2f {
  let i = owen(index, sampleSeed(seed, 0u));
  let x = reverseBits(lkPermute(i, sampleSeed(seed, 1u)));
  let y = owen(sobolD1(i), sampleSeed(seed, 2u));
  return vec2f(f32(x >> 8u), f32(y >> 8u)) * (1.0 / 16777216.0);
}
fn morton2(p: vec2u) -> u32 {
  var v = p & vec2u(255u);
  v = (v | (v << vec2u(4u))) & vec2u(0x0f0fu);
  v = (v | (v << vec2u(2u))) & vec2u(0x3333u);
  v = (v | (v << vec2u(1u))) & vec2u(0x5555u);
  return v.x | (v.y << 1u);
}
${zSobolPackedPermutations.map((v,i) => `const Z_PERM_${i} = ${v}u;`).join("\n")}
fn zSobolPermutation(perm: u32) -> u32 {
  let group = perm >> 2u;
  var word = Z_PERM_5;
  ${[0,1,2,3,4].map(i => `word = select(word, Z_PERM_${i}, group == ${i}u);`).join("\n  ")}
  return (word >> ((perm & 3u) * 8u)) & 255u;
}
fn zSobolIndex(morton: u32, dim: u32, logSPP: u32) -> u32 {
  let odd = logSPP & 1u;
  let digits = 8u + ((logSPP + 1u) >> 1u);
  var result = 0u;
  for (var digit = i32(digits) - 1; digit >= i32(odd); digit--) {
    let shift = 2u*u32(digit) - odd;
    // A shift by 32 is undefined on GLSL and masks to zero on some GPUs.
    var higher = 0u;
    if (shift < 30u) { higher = morton >> (shift + 2u); }
    let perm = (sampleHash(higher ^ (0x55555555u * dim)) >> 24u) % 24u;
    let d = (morton >> shift) & 3u;
    result |= ((zSobolPermutation(perm) >> (2u*d)) & 3u) << shift;
  }
  if (odd != 0u) {
    result |= (morton & 1u) ^ (sampleHash((morton >> 1u) ^ (0x55555555u * dim)) & 1u);
  }
  return result;
}
// IDs count 2D domains, not scalar components. Bevel IDs follow camera IDs.
// Bounce: light selector/position, lobe/direction, medium channel/distance,
// phase direction, RR. Further candidate IDs are addressed, never consumed.
fn bounceDim(slot: u32) -> u32 {
  return CAMERA_BEVEL_BASE + u32(BEVEL_SAMPLES) + samplingBounce * BOUNCE_STRIDE + slot;
}
fn lightDim(candidate: u32, slot: u32) -> u32 {
  if (candidate == 0u) {
    if (slot == 2u) { return bounceDim(8u); }
    return bounceDim(slot);
  }
  return bounceDim(9u + (candidate - 1u) * 3u + slot);
}
// Last-domain cache shares the index shuffle and x between scalar/pair reads.
// Its keys also cover test shaders that change pixel/index within an invocation.
var<private> cachedSampleKey: vec4u;
var<private> cachedSampleLog: u32;
var<private> cachedSampleValid: bool = false;
var<private> cachedSampleYValid: bool = false;
var<private> cachedSampleIndex: u32;
var<private> cachedSampleSeed: u32;
var<private> cachedSample: vec2f;
fn prepareStructuredSample(dim: u32) {

  let pixelID = samplingPixel.x + samplingPixel.y * u32(rtUniform.outputSize.x);
  let key = vec4u(dim, pixelSampleIndex, pixelID, rtUniform.sequenceSeed);
  if (cachedSampleValid && all(cachedSampleKey == key) && cachedSampleLog == rtUniform.zSobolLogSPP) { return; }
  cachedSampleKey = key; cachedSampleLog = rtUniform.zSobolLogSPP;
  cachedSampleValid = true; cachedSampleYValid = false;
  var seed = sampleSeed(sampleSeed(pixelID, dim), rtUniform.sequenceSeed);
  var index = pixelSampleIndex;
  if (SAMPLING_PATTERN == 1) {
    var logSPP = rtUniform.zSobolLogSPP;
    if (index == 0u) { logSPP = 0u; }
    else { index -= 1u; }
    // Independent sample blocks after the cap avoid repeated samples indefinitely.
    var sequenceBlock = index >> logSPP;
    let mask = (1u << logSPP) - 1u;
    let morton = (morton2(samplingPixel) << logSPP) | (index & mask);
    index = zSobolIndex(morton, dim, logSPP);
    let tile = samplingPixel >> vec2u(8u);
    seed = sampleSeed(sampleSeed(dim, rtUniform.sequenceSeed), sampleSeed(tile.x, tile.y));
    // First and remaining streams must differ even at a two-sample budget.
    if (pixelSampleIndex != 0u) { sequenceBlock += 1u; }
    seed = sampleSeed(seed, sequenceBlock);
  }
  cachedSampleIndex = owen(index, sampleSeed(seed, 0u));
  cachedSampleSeed = seed;
  let x = reverseBits(lkPermute(cachedSampleIndex, sampleSeed(seed, 1u)));
  cachedSample.x = f32(x >> 8u) * (1.0 / 16777216.0);
}
fn structuredSample(dim: u32) -> vec2f {
  prepareStructuredSample(dim);
  if (!cachedSampleYValid) {
    let y = owen(sobolD1(cachedSampleIndex), sampleSeed(cachedSampleSeed, 2u));
    cachedSample.y = f32(y >> 8u) * (1.0 / 16777216.0);
    cachedSampleYValid = true;
  }
  return EPS + (1.0 - 2.0*EPS) * cachedSample;
}
fn sample1D(dim: u32) -> f32 {
  if (SAMPLING_PATTERN == 2) { return EPS + (1.0 - 2.0*EPS)*rand(); }
  prepareStructuredSample(dim);
  return EPS + (1.0 - 2.0*EPS) * cachedSample.x;
}
fn sample2D(dim: u32) -> vec2f {
  if (SAMPLING_PATTERN == 2) {
    let x = sample1D(dim); let y = sample1D(dim);
    return vec2f(x,y);
  }
  return structuredSample(dim);
}
// Variable traversal counts cannot move any of the structured dimensions.
fn hashedSample(slot: u32) -> f32 {
  let dim = sampleSeed(sampleSeed(samplingBounce, slot), hashedCounter) | 0x80000000u;
  hashedCounter += 1u;
  if (SAMPLING_PATTERN == 2) { return EPS + (1.0 - 2.0*EPS)*rand(); }
  // Variable-count traversal has no spatial ZSobol ordering to preserve.
  let pixelID = samplingPixel.x + samplingPixel.y * u32(rtUniform.outputSize.x);
  let seed = sampleSeed(sampleSeed(pixelID, dim), rtUniform.sequenceSeed);
  let i = owen(pixelSampleIndex, sampleSeed(seed, 0u));
  let x = reverseBits(lkPermute(i, sampleSeed(seed, 1u)));
  return EPS + (1.0 - 2.0*EPS) * (f32(x >> 8u) * (1.0 / 16777216.0));
}
`;
