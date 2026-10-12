import type { Mat4, Vec3 } from '../types.js';
import { mat4 } from '../math.js';

/** Base class of objects positioned by a local-to-world transform. */
export default abstract class SceneNode {
  /** Optional object name. Default empty string. */
  name = '';
  /**
   * Local-to-world transform: column-major 4×4 (gl-matrix layout). Default identity.
   * Edits, including in-place element edits, are detected on the next render.
   */
  transform: Mat4 = mat4.create();

  /** Reads a copy of the translation, or writes it into transform. Default `[0, 0, 0]`. */
  get position(): Vec3 {
    return [this.transform[12], this.transform[13], this.transform[14]];
  }
  set position(value: Vec3) {
    this.transform[12] = value[0];
    this.transform[13] = value[1];
    this.transform[14] = value[2];
  }

  /** Points local -Z at target, preserving position and scale. Default up `[0, 1, 0]`. */
  lookAt(target: Vec3, up: Vec3 = [0, 1, 0]): this {
    const scale = mat4.getScaling(new Float32Array(3), this.transform);
    const position = this.position;
    const direction = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
    const cross = [direction[1]*up[2]-direction[2]*up[1], direction[2]*up[0]-direction[0]*up[2], direction[0]*up[1]-direction[1]*up[0]];
    const effectiveUp: Vec3 = Math.hypot(...cross) > 1e-8 ? up
      : Math.abs(direction[2]) < Math.hypot(...direction) * .99 ? [0, 0, -1] : [1, 0, 0];
    mat4.targetTo(this.transform, position, target, effectiveUp);
    mat4.scale(this.transform, this.transform, scale);
    return this;
  }
}
