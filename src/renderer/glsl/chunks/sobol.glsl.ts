import { zSobolPackedPermutations, sobolD1Steps } from '../../sampling.js';
export default /* glsl */ `
uint reverseBits(uint x) {
  x = ((x & 0x55555555u) << 1u) | ((x >> 1u) & 0x55555555u);
  x = ((x & 0x33333333u) << 2u) | ((x >> 2u) & 0x33333333u);
  x = ((x & 0x0f0f0f0fu) << 4u) | ((x >> 4u) & 0x0f0f0f0fu);
  x = ((x & 0x00ff00ffu) << 8u) | ((x >> 8u) & 0x00ff00ffu);
  return (x << 16u) | (x >> 16u);
}

const uint CAMERA_PIXEL = 0u;
const uint CAMERA_LENS = 1u;
const uint CAMERA_WAVELENGTH = 2u;
const uint CAMERA_BEVEL_BASE = 3u;
const uint LIGHT_SELECT = 0u;
const uint LIGHT_POSITION = 1u;
const uint BSDF_LOBE = 2u;
const uint BSDF_DIRECTION = 3u;
const uint MEDIUM_CHANNEL = 4u;
const uint MEDIUM_DISTANCE = 5u;
const uint PHASE_DIRECTION = 6u;
const uint RUSSIAN_ROULETTE = 7u;
const uint BOUNCE_STRIDE = 64u;

// Burley 2020, Practical Hash-based Owen Scrambling, JCGT 9(4).
// ZSobol digit walk adapted from pbrt-v4 samplers.h (Apache-2.0).
uvec2 samplingPixel;
uint pixelSampleIndex;
uint samplingBounce = 0u;
uint hashedCounter = 0u;
uint sampleHash(uint valueIn) {
  uint x = valueIn;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  return x ^ (x >> 16u);
}
uint sampleSeed(uint a, uint b) {
  return sampleHash(a ^ sampleHash(b + 0x9e3779b9u));
}
uint lkPermute(uint valueIn, uint seed) {
  uint x = valueIn + seed;
  x ^= x * 0x6c50b47cu; x ^= x * 0xb82f1e52u;
  x ^= x * 0xc7afe638u; x ^= x * 0x8d22f6e6u;
  return x;
}
uint owen(uint x, uint seed) {
  return reverseBits(lkPermute(reverseBits(x), seed));
}
// Parallel XOR butterfly equals v ^= v >> 1 for all 32 direction bits.
uint sobolD1(uint valueIn) {
  uint r = reverseBits(valueIn);
  ${sobolD1Steps.map(([shift, mask]) => `r ^= (r << ${shift}u) & 0x${mask.toString(16)}u;`).join("\n  ")}
  return r;
}
vec2 sobol2D(uint index, uint seed) {
  uint i = owen(index, sampleSeed(seed, 0u));
  uint x = reverseBits(lkPermute(i, sampleSeed(seed, 1u)));
  uint y = owen(sobolD1(i), sampleSeed(seed, 2u));
  return vec2(float(x >> 8u), float(y >> 8u)) * (1.0 / 16777216.0);
}
uint morton2(uvec2 p) {
  uvec2 v = p & uvec2(255u);
  v = (v | (v << uvec2(4u))) & uvec2(0x0f0fu);
  v = (v | (v << uvec2(2u))) & uvec2(0x3333u);
  v = (v | (v << uvec2(1u))) & uvec2(0x5555u);
  return v.x | (v.y << 1u);
}
${zSobolPackedPermutations.map((v,i) => `const uint Z_PERM_${i} = ${v}u;`).join("\n")}
uint zSobolPermutation(uint perm) {
  uint group = perm >> 2u;
  uint word = Z_PERM_5;
  ${[0,1,2,3,4].map(i => `word = group == ${i}u ? Z_PERM_${i} : word;`).join("\n  ")}
  return (word >> ((perm & 3u) * 8u)) & 255u;
}
uint zSobolIndex(uint morton, uint dim, uint logSPP) {
  uint odd = logSPP & 1u;
  uint digits = 8u + ((logSPP + 1u) >> 1u);
  uint result = 0u;
  for (int digit = int(digits) - 1; digit >= int(odd); digit--) {
    uint shift = 2u*uint(digit) - odd;
    // A shift by 32 is undefined on GLSL and masks to zero on some GPUs.
    uint higher = 0u;
    if (shift < 30u) { higher = morton >> (shift + 2u); }
    uint perm = (sampleHash(higher ^ (0x55555555u * dim)) >> 24u) % 24u;
    uint d = (morton >> shift) & 3u;
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
uint bounceDim(uint slot) {
  return CAMERA_BEVEL_BASE + uint(BEVEL_SAMPLES) + samplingBounce * BOUNCE_STRIDE + slot;
}
// Last-domain cache shares the index shuffle and x between scalar/pair reads.
uvec4 cachedSampleKey;
uint cachedSampleLog;
bool cachedSampleValid = false;
bool cachedSampleYValid = false;
uint cachedSampleIndex;
uint cachedSampleSeed;
vec2 cachedSample;
void prepareStructuredSample(uint dim) {

  uint pixelID = samplingPixel.x + samplingPixel.y * uint(round(1.0 / pixelSize.x));
  uvec4 key = uvec4(dim, pixelSampleIndex, pixelID, uint(sequenceSeed));
  if (cachedSampleValid && all(equal(cachedSampleKey, key)) && cachedSampleLog == uint(zSobolLogSPP)) { return; }
  cachedSampleKey = key; cachedSampleLog = uint(zSobolLogSPP);
  cachedSampleValid = true; cachedSampleYValid = false;
  uint seed = sampleSeed(sampleSeed(pixelID, dim), uint(sequenceSeed));
  uint index = pixelSampleIndex;
  if (samplingPattern == 1) {
    uint logSPP = uint(zSobolLogSPP);
    if (index == 0u) { logSPP = 0u; }
    else { index -= 1u; }
    // Independent sample blocks after the cap avoid repeated samples indefinitely.
    uint sequenceBlock = index >> logSPP;
    uint mask = (1u << logSPP) - 1u;
    uint morton = (morton2(samplingPixel) << logSPP) | (index & mask);
    index = zSobolIndex(morton, dim, logSPP);
    uvec2 tile = samplingPixel >> uvec2(8u);
    seed = sampleSeed(sampleSeed(dim, uint(sequenceSeed)), sampleSeed(tile.x, tile.y));
    // First and remaining streams must differ even at a two-sample budget.
    if (pixelSampleIndex != 0u) { sequenceBlock += 1u; }
    seed = sampleSeed(seed, sequenceBlock);
  }
  cachedSampleIndex = owen(index, sampleSeed(seed, 0u));
  cachedSampleSeed = seed;
  uint x = reverseBits(lkPermute(cachedSampleIndex, sampleSeed(seed, 1u)));
  cachedSample.x = float(x >> 8u) * (1.0 / 16777216.0);
}
vec2 structuredSample(uint dim) {
  prepareStructuredSample(dim);
  if (!cachedSampleYValid) {
    uint y = owen(sobolD1(cachedSampleIndex), sampleSeed(cachedSampleSeed, 2u));
    cachedSample.y = float(y >> 8u) * (1.0 / 16777216.0);
    cachedSampleYValid = true;
  }
  return EPS + (1.0 - 2.0*EPS) * cachedSample;
}
float sample1D(uint dim) {
  if (samplingPattern == 2) { return EPS + (1.0 - 2.0*EPS)*rand(); }
  prepareStructuredSample(dim);
  return EPS + (1.0 - 2.0*EPS) * cachedSample.x;
}
vec2 sample2D(uint dim) {
  if (samplingPattern == 2) {
    float x = sample1D(dim); float y = sample1D(dim);
    return vec2(x,y);
  }
  return structuredSample(dim);
}
// Variable traversal counts cannot move any of the structured dimensions.
float hashedSample(uint slot) {
  uint dim = sampleSeed(sampleSeed(samplingBounce, slot), hashedCounter) | 0x80000000u;
  hashedCounter += 1u;
  if (samplingPattern == 2) { return EPS + (1.0 - 2.0*EPS)*rand(); }
  // Variable-count traversal has no spatial ZSobol ordering to preserve.
  uint pixelID = samplingPixel.x + samplingPixel.y * uint(round(1.0 / pixelSize.x));
  uint seed = sampleSeed(sampleSeed(pixelID, dim), uint(sequenceSeed));
  uint i = owen(pixelSampleIndex, sampleSeed(seed, 0u));
  uint x = reverseBits(lkPermute(i, sampleSeed(seed, 1u)));
  return EPS + (1.0 - 2.0*EPS) * (float(x >> 8u) * (1.0 / 16777216.0));
}
`;
