import type { vec3 } from '../math.js';

export class Box3 {
  min: vec3.Vec3Array;
  max: vec3.Vec3Array;

  constructor() {
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
  }
}
