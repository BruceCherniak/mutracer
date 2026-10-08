/** Builds per-tile variance history and per-pixel final sample targets on GPU. */
export const offlineAdaptiveCompute = /* wgsl */ `
struct OfflineAdaptiveParams {
  width: u32,
  height: u32,
  tileSize: u32,
  columns: u32,
  rows: u32,
  maxSamples: u32,
  minSamples: u32,
  hasPrevious: u32,
  absoluteError: f32,
  relativeError: f32,
  confidence: f32,
  _padding: f32,
}

@group(0) @binding(0) var<uniform> params: OfflineAdaptiveParams;
@group(0) @binding(1) var<storage, read> pilotColor: array<f32>;
@group(0) @binding(2) var<storage, read> pilotMoments: array<f32>;
@group(0) @binding(3) var<storage, read> previousVariance: array<f32>;
@group(0) @binding(4) var<storage, read_write> tileMeans: array<f32>;
@group(0) @binding(5) var<storage, read_write> tileVariances: array<f32>;
@group(0) @binding(6) var<storage, read_write> tileTargets: array<u32>;
@group(0) @binding(7) var targetTexture: texture_storage_2d<r32float, write>;

const LUMINANCE = vec3f(0.2126, 0.7152, 0.0722);

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let tile = invocation.x;
  let tileCount = params.columns * params.rows;
  if (tile >= tileCount) {
    return;
  }

  let tileX = tile % params.columns;
  let tileY = tile / params.columns;
  let startX = tileX * params.tileSize;
  let startY = tileY * params.tileSize;
  let endX = min(startX + params.tileSize, params.width);
  let endY = min(startY + params.tileSize, params.height);
  var meanSum = 0.0;
  var maximumVariance = 0.0;
  var count = 0u;

  for (var y = startY; y < endY; y++) {
    for (var x = startX; x < endX; x++) {
      let pixel = y * params.width + x;
      let offset = pixel * 4u;
      let samples = pilotMoments[offset + 3u];
      if (samples <= 0.0) {
        continue;
      }
      let mean = dot(
        vec3f(
          pilotColor[offset],
          pilotColor[offset + 1u],
          pilotColor[offset + 2u]
        ),
        LUMINANCE
      ) / samples;
      let secondMoment = pilotMoments[offset] / samples;
      let biasedVariance = max(secondMoment - mean * mean, 0.0);
      var variance = biasedVariance;
      if (samples > 1.0) {
        variance = biasedVariance * samples / (samples - 1.0);
      }
      meanSum += mean;
      maximumVariance = max(maximumVariance, variance);
      count += 1u;
    }
  }

  let mean = meanSum / f32(max(count, 1u));
  var historyVariance = 0.0;
  if (params.hasPrevious != 0u) {
    historyVariance = previousVariance[tile];
  }
  let budgetVariance = max(maximumVariance, historyVariance);
  let tolerance = params.absoluteError + params.relativeError * abs(mean);
  let required = ceil(
    params.confidence * params.confidence * budgetVariance /
      max(tolerance * tolerance, 1e-16)
  );
  let targetSamples = u32(min(
    f32(params.maxSamples),
    max(f32(params.minSamples), required)
  ));

  tileMeans[tile] = mean;
  // Persist only the current pilot's raw variance. The preceding frame can
  // raise this frame's budget without poisoning every later frame.
  tileVariances[tile] = maximumVariance;
  tileTargets[tile] = targetSamples;

  for (var y = startY; y < endY; y++) {
    for (var x = startX; x < endX; x++) {
      textureStore(
        targetTexture,
        vec2i(i32(x), i32(y)),
        vec4f(f32(targetSamples), 0.0, 0.0, 0.0)
      );
    }
  }
}
`;
