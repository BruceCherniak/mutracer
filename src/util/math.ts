import { mat4, vec3 } from '../math.js';

const xa = vec3.create();
const xb = vec3.create();
const ya = vec3.create();
const yb = vec3.create();
const za = vec3.create();
const zb = vec3.create();
const mathMin = Math.min;
const mathMax = Math.max;
export function transformBoundingBox(
  out: {
    min: vec3.Vec3Array;
    max: vec3.Vec3Array;
  },
  source: { min: vec3.Vec3Array; max: vec3.Vec3Array },
  m: mat4.Mat4Array
) {
  let min = source.min;
  let max = source.max;
  xa[0] = m[0] * min[0];
  xa[1] = m[1] * min[0];
  xa[2] = m[2] * min[0];
  xb[0] = m[0] * max[0];
  xb[1] = m[1] * max[0];
  xb[2] = m[2] * max[0];

  ya[0] = m[4] * min[1];
  ya[1] = m[5] * min[1];
  ya[2] = m[6] * min[1];
  yb[0] = m[4] * max[1];
  yb[1] = m[5] * max[1];
  yb[2] = m[6] * max[1];

  za[0] = m[8] * min[2];
  za[1] = m[9] * min[2];
  za[2] = m[10] * min[2];
  zb[0] = m[8] * max[2];
  zb[1] = m[9] * max[2];
  zb[2] = m[10] * max[2];

  min = out.min;
  max = out.max;
  min[0] =
    mathMin(xa[0], xb[0]) +
    mathMin(ya[0], yb[0]) +
    mathMin(za[0], zb[0]) +
    m[12];
  min[1] =
    mathMin(xa[1], xb[1]) +
    mathMin(ya[1], yb[1]) +
    mathMin(za[1], zb[1]) +
    m[13];
  min[2] =
    mathMin(xa[2], xb[2]) +
    mathMin(ya[2], yb[2]) +
    mathMin(za[2], zb[2]) +
    m[14];

  max[0] =
    mathMax(xa[0], xb[0]) +
    mathMax(ya[0], yb[0]) +
    mathMax(za[0], zb[0]) +
    m[12];
  max[1] =
    mathMax(xa[1], xb[1]) +
    mathMax(ya[1], yb[1]) +
    mathMax(za[1], zb[1]) +
    m[13];
  max[2] =
    mathMax(xa[2], xb[2]) +
    mathMax(ya[2], yb[2]) +
    mathMax(za[2], zb[2]) +
    m[14];
}
