/** Generate sampling wrappers; shader callers always use these explicit names. */
export function scratchWGSLFunctions(
  textures: readonly string[],
  samplers: readonly string[],
  scratch = false
) {
  return textures.map((name, index) => /* wgsl */ `
fn ${name}Region() -> vec2u {
  return ${scratch ? `imageRegions[${index}].xy` : `textureDimensions(${name})`};
}
fn load_${name}(pixel: vec2i, level: i32) -> vec4f {
  ${scratch ? `if (any(pixel < vec2i(0)) || any(pixel >= vec2i(${name}Region()))) { return vec4f(0.0); }` : ''}
  return textureLoad(${name}, pixel, level);
}
${samplers.map(sampler => /* wgsl */ `
fn sample_${name}_${sampler}(coord: vec2f) -> vec4f {
  ${scratch ? /* wgsl */ `
  let physicalSize = textureDimensions(${name});
  if (all(physicalSize == ${name}Region())) { return textureSampleLevel(${name}, ${sampler}, coord, 0.0); }
  let pixel = clamp(coord * vec2f(${name}Region()), vec2f(0.5), vec2f(${name}Region()) - vec2f(0.5));
  return textureSampleLevel(${name}, ${sampler}, pixel / vec2f(physicalSize), 0.0);`
  : `return textureSample(${name}, ${sampler}, coord);`}
}`).join('')}`).join('');
}

export function scratchGLSLFunctions(textures: readonly string[], scratch = false) {
  return textures.map(name => /* glsl */ `
ivec2 ${name}Region() {
  return ${scratch ? `${name}RegionSize` : `textureSize(${name}, 0)`};
}
vec4 load_${name}(ivec2 pixel, int level) {
  ${scratch ? `if (any(lessThan(pixel, ivec2(0))) || any(greaterThanEqual(pixel, ${name}Region()))) return vec4(0.0);` : ''}
  return texelFetch(${name}, pixel, level);
}
vec4 sample_${name}(vec2 coord) {
  ${scratch ? /* glsl */ `
  ivec2 physicalSize = textureSize(${name}, 0);
  if (all(equal(physicalSize, ${name}Region()))) return texture(${name}, coord);
  vec2 pixel = clamp(coord * vec2(${name}Region()), vec2(0.5), vec2(${name}Region()) - vec2(0.5));
  return texture(${name}, pixel / vec2(physicalSize));`
  : `return texture(${name}, coord);`}
}`).join('');
}
