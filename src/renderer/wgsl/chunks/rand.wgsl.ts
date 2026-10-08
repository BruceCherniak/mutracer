// RNG adapted from GLSL-PathTracer (https://github.com/knightcrawler25/GLSL-PathTracer),
// Copyright (c) 2019 Asif Ali, MIT license, which credits Moroz Mykhailo
// (https://www.shadertoy.com/view/wltcRS).

export default /* wgsl */ `
var<private> s0: vec4u;
var<private> s1: vec4u;
var<private> pixel: vec2u;

fn rng_initialize(p: vec2u, frame: i32) {
  pixel = p;

  //white noise seed
  s0 = vec4u(p, u32(frame), u32(p.x) + u32(p.y));

  //blue noise seed
  s1 = vec4u(u32(frame), u32(frame)*15843, u32(frame)*31 + 4566, u32(frame)*2345 + 58585);
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

// fn rand2() -> vec2 {
//   pcg4d(s0); return vec2(f32(s0.x), f32(s0.y))/f32(0xffffffffu);
// }

// fn rand3() -> vec3 {
//   pcg4d(s0); return vec3(f32(s0.x), f32(s0.y), f32(s0.z))/f32(0xffffffffu);
// }

// fn rand4() -> vec4 {
//   pcg4d(s0); return vec4(f32(s0.x), f32(s0.y), f32(s0.z), f32(s0.w))/f32(0xffffffffu);
// }

//random blue noise sampling pos
// fn shift2() -> vec2f {
//   pcg4d(s1);
//   return vec2(f32(pixel.x + s1.x%0x0fffffffu), f32(pixel.y + s1.y%0x0fffffffu))%1024.0;
// }
`;
