import { mat4 } from '../math';

/** Base class of objects placed in the scene by a world matrix. */
export default class SceneNode {
  name: string = '';
  /**
   * Local-to-world transform (column-major 4x4, gl-matrix layout).
   * Mesh matrix edits, including element edits in place, are detected on the
   * next render. Both WebGPU and WebGL 2 refit changed instances.
   */
  matrixWorld = mat4.create();
}
