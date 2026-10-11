import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { focusPull, guessMetersPerUnit, measureAreaDepth, pickFocusDepth } from '../../viewer/src/engine/areaFocus';

function scene() {
  const root = new THREE.Group();
  // A small box in front of a large wall.
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial());
  box.position.set(0, 0, 0);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial());
  wall.position.set(0, 0, -5);
  wall.scale.setScalar(2);
  root.add(box, wall);
  root.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(35, 1.5, 0.1, 100);
  camera.position.set(0, 0, 4);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { root, camera, box };
}

describe('viewer area focus', () => {
  it('measures the view depth of the subject inside the area', () => {
    const { root, camera } = scene();
    // Box front face at z = 0.2: depth 3.8 from the camera.
    expect(measureAreaDepth(root, camera, { x: 0.5, y: 0.5, size: 0.03 }, 1.5)).toBeCloseTo(3.8, 4);
    // Off to the side only the wall is visible; depth is along the view axis.
    expect(measureAreaDepth(root, camera, { x: 0.85, y: 0.3, size: 0.05 }, 1.5)).toBeCloseTo(9, 4);
  });

  it('agrees with the Three.js raycaster for transformed and instanced meshes', () => {
    const { root, camera, box } = scene();
    box.rotation.set(0.3, 0.5, 0.1);
    box.scale.set(2, 1, 3);
    root.updateMatrixWorld(true);
    const fast = measureAreaDepth(root, camera, { x: 0.5, y: 0.5, size: 0.005 }, 1.5)!;
    const hit = new THREE.Raycaster(camera.position, new THREE.Vector3(0, 0, -1)).intersectObject(box)[0];
    expect(fast).toBeCloseTo(hit.distance, 2);

    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial(), 1);
    instanced.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 2));
    const group = new THREE.Group().add(instanced);
    group.updateMatrixWorld(true);
    expect(measureAreaDepth(group, camera, { x: 0.5, y: 0.5, size: 0.01 }, 1.5)).toBeCloseTo(1.8, 4);
  });

  it('returns null when the area shows nothing', () => {
    const { camera } = scene();
    expect(measureAreaDepth(new THREE.Group(), camera, { x: 0.5, y: 0.5, size: 0.05 }, 1.5)).toBeNull();
  });

  it('prefers the nearest supported cluster over stray hits', () => {
    expect(pickFocusDepth([1, 5, 5.1, 5.2, 9, 9, 9, 9, 9, 9], 10)).toBeCloseTo(5.1);
    expect(pickFocusDepth([3], 49)).toBe(3);
    expect(pickFocusDepth([], 49)).toBeNull();
  });

  it('guesses scene units from the model size', () => {
    expect(guessMetersPerUnit(1.8)).toBe(1);
    expect(guessMetersPerUnit(180)).toBe(1);
    expect(guessMetersPerUnit(450)).toBe(0.01);
    expect(guessMetersPerUnit(90_000)).toBe(0.001);
  });

  it('pulls focus with a settling overshoot and ends on the target', () => {
    const samples = Array.from({ length: 60 }, (_, i) => focusPull(2, 4, i * 10).distance);
    expect(Math.max(...samples)).toBeGreaterThan(4);
    expect(focusPull(2, 4, 10_000)).toEqual({ distance: 4, done: true });
    expect(focusPull(2, 4, 0).distance).toBeCloseTo(2);
  });
});
