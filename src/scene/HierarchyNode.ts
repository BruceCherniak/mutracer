import { mat4 } from '../math.js';
import SceneNode from './SceneNode.js';

export default class HierarchyNode {
  // Matrix will be set from outside
  matrix = mat4.create();
  matrixWorld = mat4.create();
  sceneNodes?: SceneNode[];
  children: HierarchyNode[] = [];

  updateMatrixWorld(parentMatrixWorld?: mat4.Mat4Array) {
    const matrixWorld = this.matrixWorld;
    const sceneNode = this.sceneNodes;
    if (!parentMatrixWorld) {
      mat4.copy(matrixWorld, this.matrix);
    } else {
      mat4.mul(matrixWorld, parentMatrixWorld, this.matrix);
    }
    if (sceneNode) {
      if (Array.isArray(sceneNode)) {
        for (let i = 0; i < sceneNode.length; i++) {
          mat4.copy(sceneNode[i].matrixWorld, matrixWorld);
        }
      }
    }

    for (let i = 0; i < this.children.length; i++) {
      this.children[i].updateMatrixWorld(matrixWorld);
    }
  }
}
