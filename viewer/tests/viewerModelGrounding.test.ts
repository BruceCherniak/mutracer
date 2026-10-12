import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { groundModel } from '../src/engine/modelGrounding';

describe('viewer model grounding', () => {
  it('grounds actual geometry when rotated local bounds extend below it', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, 1, 0, 1, 1, 0, 0, -1, 0
    ], 3));
    const mesh = new THREE.Mesh(geometry);
    mesh.rotation.z = Math.PI / 4;
    const root = new THREE.Group();
    root.position.set(5, 3, -7);
    root.scale.setScalar(2);
    const child = new THREE.Group();
    child.position.set(2, 4, 1);
    child.add(mesh);
    root.add(child);
    root.updateMatrixWorld(true);
    const oldBounds = new THREE.Box3().setFromObject(root);
    const vertexBounds = new THREE.Box3().setFromObject(root, true);
    expect(vertexBounds.min.y - oldBounds.min.y).toBeGreaterThan(1);

    groundModel(root);

    const grounded = new THREE.Box3().setFromObject(root, true);
    expect(grounded.min.y).toBeCloseTo(0, 12);
    const center = grounded.getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(0, 12);
    expect(center.z).toBeCloseTo(0, 12);
    const size = grounded.getSize(new THREE.Vector3()).toArray();
    vertexBounds.getSize(new THREE.Vector3()).toArray().forEach((value, i) => {
      expect(size[i]).toBeCloseTo(value, 12);
    });
    expect(root.scale.toArray()).toEqual([2, 2, 2]);
  });

  it('leaves an empty model transform unchanged', () => {
    const root = new THREE.Group();
    root.position.set(1, 2, 3);
    groundModel(root);
    expect(root.position.toArray()).toEqual([1, 2, 3]);
  });
});
