// Shared pass bodies; each host supplies texture access and the entry point.
// Median bright pass adapted from KinoBloom (MIT), Keijiro Takahashi:
// https://github.com/keijiro/KinoBloom/blob/master/Assets/Kino/Bloom/Shader/Bloom.cginc#L96
// See THIRD_PARTY_NOTICES.md and LICENSES/KinoBloom-MIT.txt.
export const bloomBrightDefine = /* wgsl */ `
fn median(a: vec4f, b: vec4f, c: vec4f) -> vec4f {
return a + b + c - min(min(a, b), c) - max(max(a, b), c);
}
`;
export const bloomBrightMain = /* wgsl */ `

let d = vec3i(1, 1, 0);

var texel = load_colorTex(uv, 0);
let s1 = load_colorTex(uv - d.xz, 0);
let s2 = load_colorTex(uv + d.xz, 0);
let s3 = load_colorTex(uv - d.zy, 0);
let s4 = load_colorTex(uv + d.zy, 0);
texel = median(median(texel, s1, s2), s3, s4);

// Premultiplied Alpha
let lum = dot(texel.rgb, vec3f(0.2125, 0.7154, 0.0721));
var color: vec4f;
if (lum > threshold && texel.a > 0.0) {
  color = vec4f(texel.rgb * scale, texel.a);
} else {
  // Bleed the alpha to avoid sharp edge when using alpha
  color = vec4f(vec3(0.0), texel.a);
}
output.color = color;
`;
export const bloomDownDefine = /* wgsl */ `
fn brightness(c: vec3f) -> f32 {
  return max(max(c.r, c.g), c.b);
}
`;
export const bloomDownMain = /* wgsl */ `
let size = vec2f(colorTexRegion());
let d = vec4f(-1.0, -1.0, 1.0, 1.0) / size.xyxy;

output.color = sample_colorTex_linearSampler(uv2 + d.xy) * 0.25
  + sample_colorTex_linearSampler(uv2 + d.zy) * 0.25
  + sample_colorTex_linearSampler(uv2 + d.xw) * 0.25
  + sample_colorTex_linearSampler(uv2 + d.zw) * 0.25;
`;
export const bloomBlurDefine = /* wgsl */ `
const kernel = array<f32, 9>(0.07, 0.09, 0.12, 0.14, 0.16, 0.14, 0.12, 0.09, 0.07);
`;
export const bloomBlurMain = /* wgsl */ `
let texSize = vec2f(colorTexRegion());
let off = direction / texSize * size;

var sum = vec4f(0.0);
var weightAll = 0.0;
for (var i = 0; i < 9; i++) {
  let w = kernel[i];
  sum += sample_colorTex_linearSampler(uv2 + off * f32(i - 4)) * w;
  weightAll += w;
}
output.color = sum / max(weightAll, 0.01);
`;
export const bloomBlendMain = /* wgsl */ `
let color1 = sample_colorTex1_linearSampler(uv2);
let color2 = sample_colorTex2_linearSampler(uv2);
output.color = mix(color1, color2, weight);
`;

export const BLOOM_LEVELS = 6;
export function bloomBlurSize(radius: number): number {
  return Math.max(Math.min(radius * 2, 1), 0.2);
}
export function bloomBlendWeight(radius: number): number {
  return 1 - Math.max(Math.min(radius ** 0.3 * 0.8, 0.8), 0);
}

// Slots: bright, down[], horizontal[], vertical[], blend[], external input.
// Kind selects bright/down/blur/blend. Hosts only bind their own pass resources.
export type BloomStep = readonly [kind: number, a: number, b: number, target: number, dx: number, dy: number];
export function createBloomPlan(levels: number): BloomStep[] {
  const down = 1, h = down + levels, v = h + levels, blend = v + levels;
  const input = blend + levels - 1;
  const steps: BloomStep[] = [[0, input, input, 0, 0, 0]];
  for (let i = 0; i < levels; i++) {
    const source = i === 0 ? 0 : down + i - 1;
    steps.push([1, source, source, down + i, 0, 0]);
  }
  for (let i = levels - 1; i >= 0; i--) {
    steps.push([2, down + i, down + i, h + i, 1, 0]);
    steps.push([2, h + i, h + i, v + i, 0, 1]);
  }
  for (let i = levels - 2; i >= 0; i--) {
    steps.push([3, i === levels - 2 ? v + levels - 1 : blend + i + 1, v + i, blend + i, 0, 0]);
  }
  return steps;
}
export const BLOOM_PLAN = createBloomPlan(BLOOM_LEVELS);
