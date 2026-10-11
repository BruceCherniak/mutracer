import * as THREE from 'three';

/** Centers the model in X/Z and places its lowest vertex on the Y=0 ground. */
export function groundModel(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  // Rotated local bounding boxes can extend below every actual vertex.
  // Use vertex bounds once at load time to avoid lifting the model off the floor.
  const box = new THREE.Box3().setFromObject(root, true);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
}
