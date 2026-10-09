import type * as THREE from 'three';
import { mat4 } from '../math';

type FloatAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
const attributes = ['position', 'normal', 'tangent', 'skinIndex', 'skinWeight'] as const;
/** Decode storage directly, including interleaved offsets and normalized integers. */
function reader(attribute: FloatAttribute) {
  const interleaved = attribute as THREE.InterleavedBufferAttribute;
  const array = interleaved.isInterleavedBufferAttribute ? interleaved.data.array : attribute.array;
  const stride = interleaved.isInterleavedBufferAttribute ? interleaved.data.stride : attribute.itemSize;
  const offset = interleaved.isInterleavedBufferAttribute ? interleaved.offset : 0;
  if (!attribute.normalized && !(attribute as FloatAttribute & { isFloat16BufferAttribute?: boolean }).isFloat16BufferAttribute) {
    return { array, stride, offset };
  }
  const decoded = new Float64Array(attribute.count * attribute.itemSize);
  let divisor = 1, signed = false;
  if (attribute.normalized) {
    if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) divisor = 255;
    else if (array instanceof Uint16Array) divisor = 65535;
    else if (array instanceof Uint32Array) divisor = 4294967295;
    else if (array instanceof Int8Array) { divisor = 127; signed = true; }
    else if (array instanceof Int16Array) { divisor = 32767; signed = true; }
    else if (array instanceof Int32Array) { divisor = 2147483647; signed = true; }
  }
  const half = (attribute as FloatAttribute & { isFloat16BufferAttribute?: boolean }).isFloat16BufferAttribute;
  for (let i = 0; i < attribute.count; i++) for (let c = 0; c < attribute.itemSize; c++) {
    let value = array[i * stride + offset + c];
    if (half) {
      const exponent = (value >> 10) & 31, fraction = value & 1023, sign = value & 32768 ? -1 : 1;
      value = sign * (exponent === 31 ? fraction ? NaN : Infinity :
        exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
    }
    value /= divisor;
    decoded[i * attribute.itemSize + c] = signed ? Math.max(-1, value) : value;
  }
  return { array: decoded, stride: attribute.itemSize, offset: 0 };
}
type Reader = ReturnType<typeof reader>;
function read(attribute: Reader, vertex: number, component: number) {
  return attribute.array[vertex * attribute.stride + attribute.offset + component];
}

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
  private _bones = new Float32Array(0);
  private _boundBones = new Float64Array(0);
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
      next.push(attribute, buffer.array, buffer.version, attribute.count, attribute.itemSize, attribute.normalized, interleaved.offset, interleaved.data?.stride);
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

      for (const value of skinned.bindMatrix.elements) next.push(value);
      for (const value of skinned.bindMatrixInverse.elements) next.push(value);
    }
    const boneMatrices = skinned.isSkinnedMesh ? skinned.skeleton.boneMatrices! : undefined;
    let bonesChanged = !!boneMatrices && boneMatrices.length !== this._bones.length;
    if (boneMatrices && !bonesChanged) for (let i = 0; i < boneMatrices.length; i++) {
      if (!Object.is(boneMatrices[i], this._bones[i])) { bonesChanged = true; break; }
    }
    if (this._initialized && !bonesChanged && next.length === this._accepted.length && next.every((v, i) => Object.is(v, this._accepted[i]))) return false;
    const position = reader(geometry.getAttribute('position'));
    const normal = this.normal && reader(geometry.getAttribute('normal'));
    const tangent = this.tangent && reader(geometry.getAttribute('tangent'));
    const indices = boneMatrices && reader(geometry.getAttribute('skinIndex'));
    const weights = boneMatrices && reader(geometry.getAttribute('skinWeight'));
    const positionMorphs = geometry.morphAttributes.position?.map(reader);
    const normalMorphs = geometry.morphAttributes.normal?.map(reader);
    if (boneMatrices) {
      if (this._bones.length !== boneMatrices.length) {
        this._bones = new Float32Array(boneMatrices.length);
        this._boundBones = new Float64Array(boneMatrices.length);
      }
      this._bones.set(boneMatrices);
      for (let bone = 0; bone < boneMatrices.length; bone += 16) {
        mat4.multiply(this._temporary, boneMatrices.subarray(bone, bone + 16), skinned.bindMatrix.elements);
        mat4.multiply(this._boundBones.subarray(bone, bone + 16), skinned.bindMatrixInverse.elements, this._temporary);
      }
    }
    const morphVector = (base: Reader, morphs: Reader[] | undefined, vertex: number) => {
      for (let component = 0; component < 3; component++) {
        const b = read(base, vertex, component); let value = b;
        if (influences && morphs) for (let target = 0; target < morphs.length; target++) {
          const weight = influences[target] ?? 0;
          if (weight) value += weight * (read(morphs[target], vertex, component) - (geometry.morphTargetsRelative ? 0 : b));
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
        this._skin.fill(0);
        for (let component = 0; component < 4; component++) {
          const bone = read(indices!, vertex, component), weight = read(weights!, vertex, component);
          if (!weight) continue;
          const start = bone * 16;
          for (let i = 0; i < 16; i++) this._skin[i] += weight * this._boundBones[start + i];
        }
      }
      morphVector(position, positionMorphs, vertex); write(this.position, vertex, true);
      if (this.normal) { morphVector(normal!, normalMorphs, vertex); write(this.normal, vertex, false); }
      if (this.tangent) {
        for (let component = 0; component < 3; component++) this._vector[component] = read(tangent!, vertex, component);
        write(this.tangent, vertex, false);
      }
    }
    this._next = this._accepted; this._accepted = next; this._initialized = true;
    return true;
  }
}
