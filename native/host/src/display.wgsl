
struct Params { size: vec2u, samples: f32, exposure: f32 }
@group(0) @binding(0) var<storage, read> accumulation: array<vec4f>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;
const toneMappingParams = vec4f(3.0, 0.0, 0.0, 0.0);
const colorGradingParams = vec4f(1.0, 1.0, 0.0, 0.0);


fn linearToneMapping(color: vec3f) -> vec3f {
  return clamp(color, vec3f(0.0), vec3f(1.0));
}
fn reinhardToneMapping(color: vec3f) -> vec3f {
  return clamp(color / (vec3f(1.0) + color), vec3f(0.0), vec3f(1.0));
}
fn cineonToneMapping(inputColor: vec3f) -> vec3f {
  let color = max(vec3f(0.0), inputColor - 0.004);
  return pow((color * (6.2 * color + 0.5)) /
    (color * (6.2 * color + 1.7) + 0.06), vec3f(2.2));
}
fn rrtAndOdtFit(value: vec3f) -> vec3f {
  let numerator = value * (value + 0.0245786) - 0.000090537;
  let denominator = value * (0.983729 * value + 0.4329510) + 0.238081;
  return numerator / denominator;
}
fn acesToneMapping(inputColor: vec3f) -> vec3f {
  let inputMatrix = mat3x3f(
    vec3f(0.59719, 0.07600, 0.02840),
    vec3f(0.35458, 0.90834, 0.13383),
    vec3f(0.04823, 0.01566, 0.83777)
  );
  let outputMatrix = mat3x3f(
    vec3f(1.60475, -0.10208, -0.00327),
    vec3f(-0.53108, 1.10813, -0.07276),
    vec3f(-0.07367, -0.00605, 1.07602)
  );
  let color = inputMatrix * (inputColor / 0.6);
  return clamp(outputMatrix * rrtAndOdtFit(color), vec3f(0.0), vec3f(1.0));
}
fn agxDefaultContrastApprox(value: vec3f) -> vec3f {
  let value2 = value * value;
  let value4 = value2 * value2;
  return 15.5 * value4 * value2 - 40.14 * value4 * value
    + 31.96 * value4 - 6.868 * value2 * value
    + 0.4298 * value2 + 0.1191 * value - 0.00232;
}
fn agxToneMapping(inputColor: vec3f) -> vec3f {
  let linearRec2020ToLinearSrgb = mat3x3f(
    vec3f(1.6605, -0.1246, -0.0182),
    vec3f(-0.5876, 1.1329, -0.1006),
    vec3f(-0.0728, -0.0083, 1.1187)
  );
  let linearSrgbToLinearRec2020 = mat3x3f(
    vec3f(0.6274, 0.0691, 0.0164),
    vec3f(0.3293, 0.9195, 0.0880),
    vec3f(0.0433, 0.0113, 0.8956)
  );
  let insetMatrix = mat3x3f(
    vec3f(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3f(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3f(0.0482516061458583, 0.101439036467562, 0.811302368396859)
  );
  let outsetMatrix = mat3x3f(
    vec3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3f(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3f(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
  );
  var color = insetMatrix * (linearSrgbToLinearRec2020 * inputColor);
  color = clamp((log2(max(color, vec3f(1e-10))) + 12.47393) / 16.5, vec3f(0.0), vec3f(1.0));
  color = outsetMatrix * agxDefaultContrastApprox(color);
  color = pow(max(color, vec3f(0.0)), vec3f(2.2));
  return clamp(linearRec2020ToLinearSrgb * color, vec3f(0.0), vec3f(1.0));
}
fn applyToneMapping(color: vec3f) -> vec3f {
  let toneMappingMode = i32(toneMappingParams.x);
  if (toneMappingMode == 1) { return acesToneMapping(color); }
  if (toneMappingMode == 2) { return cineonToneMapping(color); }
  if (toneMappingMode == 3) { return reinhardToneMapping(color); }
  if (toneMappingMode == 4) { return linearToneMapping(color); }
  return agxToneMapping(color);
}

fn linearToSrgb(color: vec3f) -> vec3f {
  let linear = max(color, vec3f(0.0));
  let low = linear * 12.92;
  let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3f(0.0031308));
}

fn gradeColor(inputColor: vec3f) -> vec3f {
  let contrast = colorGradingParams.x;
  let saturation = colorGradingParams.y;
  let temperature = colorGradingParams.z;
  let tint = colorGradingParams.w;
  let balance = vec3f(
    1.0 + temperature * 0.16 + tint * 0.04,
    1.0 - tint * 0.12,
    1.0 - temperature * 0.16 + tint * 0.04
  );
  var color = max(inputColor * balance, vec3f(0.0));
  color = max((color - 0.18) * contrast + 0.18, vec3f(0.0));
  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  return max(mix(vec3f(luminance), color, saturation), vec3f(0.0));
}

@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let index = (params.size.y - 1u - id.y) * params.size.x + id.x;
  let linear = accumulation[index].rgb / params.samples * exp2(params.exposure);
  textureStore(output, id.xy, vec4f(linearToSrgb(applyToneMapping(max(linear,vec3f(0.0)))), 1.0));
}