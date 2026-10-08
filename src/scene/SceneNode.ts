import { mat4 } from '../math';

/** Base class of objects placed in the scene by a world matrix. */
export default class SceneNode {
  name: string = '';
  /**
   * Local-to-world transform (column-major 4x4, gl-matrix layout). After
   * changing it on a rendered mesh, call `renderer.markMeshTransformsDirty()`.
   */
  matrixWorld = mat4.create();
}
