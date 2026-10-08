// RNG adapted from GLSL-PathTracer (https://github.com/knightcrawler25/GLSL-PathTracer),
// Copyright (c) 2019 Asif Ali, MIT license, which credits Moroz Mykhailo
// (https://www.shadertoy.com/view/wltcRS).

import { glsl } from '../../shader';

export default glsl`
uvec4 s0, s1;
ivec2 pixel;

void rng_initialize(vec2 p, int frame) {
  pixel = ivec2(p);

  //white noise seed
  s0 = uvec4(p, uint(frame), uint(p.x) + uint(p.y));

  //blue noise seed
  s1 = uvec4(frame, frame*15843, frame*31 + 4566, frame*2345 + 58585);
}

// https://www.pcg-random.org/
void pcg4d(inout uvec4 v) {
	v = v * 1664525u + 1013904223u;
  v.x += v.y*v.w; v.y += v.z*v.x; v.z += v.x*v.y; v.w += v.y*v.z;
  v = v ^ (v>>16u);
  v.x += v.y*v.w; v.y += v.z*v.x; v.z += v.x*v.y; v.w += v.y*v.z;
}

float rand() {
  pcg4d(s0); return float(s0.x)/float(0xffffffffu);
}

// vec2 rand2() {
//   pcg4d(s0); return vec2(s0.xy)/float(0xffffffffu);
// }

// vec3 rand3() {
//   pcg4d(s0); return vec3(s0.xyz)/float(0xffffffffu);
// }

// vec4 rand4() {
//   pcg4d(s0); return vec4(s0)/float(0xffffffffu);
// }

//random blue noise sampling pos
ivec2 shift2() {
  pcg4d(s1);
  return (pixel + ivec2(s1.xy%0x0fffffffu))%1024;
}
`;
