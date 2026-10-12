import type { Vec3 } from '../types.js';
import { vec3 } from '../math.js';
import type Mesh from '../scene/Mesh.js';
import { transformBoundingBox } from './math.js';

/** World-space axis-aligned bounding box `{ min, max }` of the meshes. */
export function computeMeshesBoundingBox(meshes: Mesh[]): { min: Vec3; max: Vec3 } {
  const totalBoundingBox = {
    min: vec3.fromValues(Infinity, Infinity, Infinity),
    max: vec3.fromValues(-Infinity, -Infinity, -Infinity)
  };
  const worldBoundingBox = {
    min: vec3.create(),
    max: vec3.create()
  };

  meshes.forEach((mesh) => {
    transformBoundingBox(
      worldBoundingBox,
      mesh.geometry.boundingBox,
      mesh.transform
    );
    vec3.min(totalBoundingBox.min, totalBoundingBox.min, worldBoundingBox.min);
    vec3.max(totalBoundingBox.max, totalBoundingBox.max, worldBoundingBox.max);
  });

  return totalBoundingBox;
}
