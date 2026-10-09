// RNG adapted from GLSL-PathTracer (https://github.com/knightcrawler25/GLSL-PathTracer),
// Copyright (c) 2019 Asif Ali, MIT license, which credits Moroz Mykhailo
// (https://www.shadertoy.com/view/wltcRS).

import { glsl } from '../../shader';

export default glsl`
uvec4 s0;

void rng_initialize(vec2 p, int frame) {
  //white noise seed
  s0 = uvec4(p, uint(frame), uint(p.x) + uint(p.y));
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

`;
