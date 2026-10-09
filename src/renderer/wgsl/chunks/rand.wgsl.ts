// RNG adapted from GLSL-PathTracer (https://github.com/knightcrawler25/GLSL-PathTracer),
// Copyright (c) 2019 Asif Ali, MIT license, which credits Moroz Mykhailo
// (https://www.shadertoy.com/view/wltcRS).

export default /* wgsl */ `
var<private> s0: vec4u;

fn rng_initialize(p: vec2u, frame: i32) {
  //white noise seed
  s0 = vec4u(p, u32(frame), u32(p.x) + u32(p.y));
}

// https://www.pcg-random.org/
fn pcg4d() {
	s0 = s0 * 1664525u + 1013904223u;
  s0.x += s0.y*s0.w; s0.y += s0.z*s0.x; s0.z += s0.x*s0.y; s0.w += s0.y*s0.z;
  s0 = s0 ^ (s0>>vec4(16u));
  s0.x += s0.y*s0.w; s0.y += s0.z*s0.x; s0.z += s0.x*s0.y; s0.w += s0.y*s0.z;
}

fn rand() -> f32 {
  pcg4d(); return f32(s0.x)/f32(0xffffffffu);
}

`;
