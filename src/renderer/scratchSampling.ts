/** Generate logical-region sampling for reusable scratch textures. */
export function scratchWGSL(code: string, textures: readonly string[], samplers: readonly string[]) {
  for (const name of textures) {
    code = code.replace(new RegExp(`textureDimensions\\(${name}(?:,\\s*0)?\\)`, 'g'), `${name}Region`)
      .replace(new RegExp(`textureLoad\\(${name},\\s*`, 'g'), `load_${name}(`);
    for (const sampler of samplers) code = code.replace(new RegExp(`textureSample\\(${name},\\s*${sampler},\\s*`, 'g'), `sample_${name}_${sampler}(`);
  }
  return code;
}
export function scratchWGSLFunctions(textures: readonly string[], samplers: readonly string[]) {
  return textures.map(name => /* wgsl */ `
fn load_${name}(pixel: vec2i, level: i32) -> vec4f {
  if (any(pixel < vec2i(0)) || any(pixel >= vec2i(${name}Region))) { return vec4f(0.0); }
  return textureLoad(${name}, pixel, level);
}
${samplers.map(sampler => /* wgsl */ `
fn sample_${name}_${sampler}(coord: vec2f) -> vec4f {
  let physicalSize = textureDimensions(${name});
  if (all(physicalSize == ${name}Region)) { return textureSampleLevel(${name}, ${sampler}, coord, 0.0); }
  let pixel = clamp(coord * vec2f(${name}Region), vec2f(0.5), vec2f(${name}Region) - vec2f(0.5));
  return textureSampleLevel(${name}, ${sampler}, pixel / vec2f(physicalSize), 0.0);
}`).join('')}`).join('');
}
export function scratchGLSL(code: string, textures: readonly string[]) {
  for (const name of textures) code = code.replace(new RegExp(`textureSize\\(${name},\\s*0\\)`, 'g'), `${name}Region`)
    .replace(new RegExp(`texelFetch\\(${name},\\s*`, 'g'), `load_${name}(`)
    .replace(new RegExp(`texture\\(${name},\\s*`, 'g'), `sample_${name}(`);
  return code;
}
export function scratchGLSLFunctions(textures: readonly string[]) {
  return textures.map(name => /* glsl */ `
vec4 load_${name}(ivec2 pixel, int level) {
  if (any(lessThan(pixel, ivec2(0))) || any(greaterThanEqual(pixel, ${name}Region))) return vec4(0.0);
  return texelFetch(${name}, pixel, level);
}
vec4 sample_${name}(vec2 coord) {
  ivec2 physicalSize = textureSize(${name}, 0);
  if (all(equal(physicalSize, ${name}Region))) return texture(${name}, coord);
  vec2 pixel = clamp(coord * vec2(${name}Region), vec2(0.5), vec2(${name}Region) - vec2(0.5));
  return texture(${name}, pixel / vec2(physicalSize));
}`).join('');
}
