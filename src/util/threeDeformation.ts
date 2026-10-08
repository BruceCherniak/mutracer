import type * as THREE from 'three';
import { mat4 } from '../math';

type FloatAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
const attributes = ['position', 'normal', 'tangent', 'skinIndex', 'skinWeight'] as const;
const getters = ['getX', 'getY', 'getZ', 'getW'] as const;

export function isDeformingMesh(mesh: THREE.Mesh) {
  return !!(mesh as THREE.SkinnedMesh).isSkinnedMesh || !!mesh.morphTargetInfluences &&
    (!!mesh.geometry.morphAttributes.position?.length || !!mesh.geometry.morphAttributes.normal?.length);
}

/** One reusable evaluator per mesh, since skeletons may share a BufferGeometry. */
export class THREEDeformation {
  readonly position: Float32Array;
  readonly normal?: Float32Array;
  readonly tangent?: Float32Array;
  private _accepted: unknown[] = [];
  private _next: unknown[] = [];
  private _weighted = new Float64Array(16);
  private _temporary = new Float64Array(16);
  private _skin = new Float64Array(16);
  private _vector = new Float64Array(3);
  private _initialized = false;

  constructor(readonly geometry: THREE.BufferGeometry) {
    const count = geometry.attributes.position.count;
    this.position = new Float32Array(count * 3);
    if (geometry.attributes.normal) this.normal = new Float32Array(count * 3);
    if (geometry.attributes.tangent) this.tangent = new Float32Array(count * 3);
  }

  matches(geometry: THREE.BufferGeometry) {
    return this.geometry === geometry && this.position.length === geometry.attributes.position.count * 3 &&
      !!this.normal === !!geometry.attributes.normal && !!this.tangent === !!geometry.attributes.tangent;
  }

  update(mesh: THREE.Mesh) {
    const geometry = mesh.geometry, skinned = mesh as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) skinned.skeleton.update();
    const next = this._next; next.length = 0;
    next.push(geometry, geometry.morphTargetsRelative);
    const capture = (attribute?: FloatAttribute) => {
      if (!attribute) { next.push(undefined); return; }
      const interleaved = attribute as THREE.InterleavedBufferAttribute;
      const buffer = interleaved.isInterleavedBufferAttribute ? interleaved.data : attribute as THREE.BufferAttribute;
      next.push(attribute, buffer.array, buffer.version, attribute.count, attribute.itemSize, attribute.normalized);
    };
    for (const name of attributes) capture(geometry.getAttribute(name));
    for (const name of ['position', 'normal'] as const) {
      const morphs = geometry.morphAttributes[name]; next.push(morphs?.length);
      if (morphs) for (const attribute of morphs) capture(attribute);
    }
    const influences = mesh.morphTargetInfluences;
    next.push(influences?.length);
    if (influences) for (const influence of influences) next.push(influence);
    if (skinned.isSkinnedMesh) {
      next.push(skinned.skeleton, skinned.skeleton.boneMatrices!.length);
      for (const value of skinned.skeleton.boneMatrices!) next.push(value);
      for (const value of skinned.bindMatrix.elements) next.push(value);
      for (const value of skinned.bindMatrixInverse.elements) next.push(value);
    }
    if (this._initialized && next.length === this._accepted.length && next.every((v, i) => Object.is(v, this._accepted[i]))) return false;
    const morphVector = (name: 'position' | 'normal', vertex: number) => {
      const base = geometry.getAttribute(name), morphs = geometry.morphAttributes[name];
      for (let component = 0; component < 3; component++) {
        const b = base[getters[component]](vertex); let value = b;
        if (influences && morphs) for (let target = 0; target < morphs.length; target++) {
          const weight = influences[target] ?? 0;
          if (weight) value += weight * (morphs[target][getters[component]](vertex) - (geometry.morphTargetsRelative ? 0 : b));
        }
        this._vector[component] = value;
      }
    };
    const write = (target: Float32Array, vertex: number, position: boolean) => {
      let x = this._vector[0], y = this._vector[1], z = this._vector[2];
      if (skinned.isSkinnedMesh) {
        const matrix = this._skin;
        const tx = matrix[0] * x + matrix[4] * y + matrix[8] * z + (position ? matrix[12] : 0);
        const ty = matrix[1] * x + matrix[5] * y + matrix[9] * z + (position ? matrix[13] : 0);
        const tz = matrix[2] * x + matrix[6] * y + matrix[10] * z + (position ? matrix[14] : 0);
        x = tx; y = ty; z = tz;
        if (!position) { const length = Math.hypot(x,y,z); if (length) { x /= length; y /= length; z /= length; } }
      }
      target[vertex * 3] = x; target[vertex * 3 + 1] = y; target[vertex * 3 + 2] = z;
    };
    for (let vertex = 0; vertex < this.position.length / 3; vertex++) {
      if (skinned.isSkinnedMesh) {
        this._weighted.fill(0);
        const indices = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
        for (let component = 0; component < 4; component++) {
          const bone = indices[getters[component]](vertex), weight = weights[getters[component]](vertex);
          if (!weight) continue;
          for (let i = 0; i < 16; i++) this._weighted[i] += weight * skinned.skeleton.boneMatrices![bone * 16 + i];
        }
        mat4.multiply(this._temporary, this._weighted, skinned.bindMatrix.elements);
        mat4.multiply(this._skin, skinned.bindMatrixInverse.elements, this._temporary);
      }
      morphVector('position', vertex); write(this.position, vertex, true);
      if (this.normal) { morphVector('normal', vertex); write(this.normal, vertex, false); }
      if (this.tangent) {
        const tangent = geometry.getAttribute('tangent');
        for (let component = 0; component < 3; component++) this._vector[component] = tangent[getters[component]](vertex);
        write(this.tangent, vertex, false);
      }
    }
    this._next = this._accepted; this._accepted = next; this._initialized = true;
    return true;
  }
}
