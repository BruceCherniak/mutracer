import { vec3 } from '../math';
import { FlattendBVH } from '../renderer/bvhAccel';

type AttributeData = Float32Array | Uint16Array | Uint32Array | Int32Array;
export class Attribute<T extends AttributeData = AttributeData> {
  array: T;
  itemSize: number;
  constructor(array: T, itemSize: number) {
    this.array = array;
    this.itemSize = itemSize;
  }

  static getItem(attr: Attribute, out: number[], vertexIndex: number) {
    const array = attr.array;
    const itemSize = attr.itemSize;
    const offset = vertexIndex * itemSize;
    for (let i = 0; i < itemSize; i++) {
      out[i] = array[offset + i];
    }
  }

  static getCount(attr: Attribute) {
    return attr.array.length / attr.itemSize;
  }
}

export type AttributeName =
  | 'position'
  | 'normal'
  | 'tangent'
  | 'uv'
  | 'uv1'
  | 'color';
export const AVAILABLE_ATTRIBUTES: AttributeName[] = [
  'position',
  'normal',
  'tangent',
  'uv',
  'uv1',
  'color'
];

export type GeometryData = Record<AttributeName, Attribute<Float32Array>> & {
  indices: Attribute<Uint16Array | Uint32Array>;
  materialIndex: Attribute<Int32Array>;
};

/**
 * Indexed triangle mesh data. `position`, `normal` and `indices` are required;
 * `normal` can be generated with `generateVertexNormals()`.
 */
export default class Geometry {
  /** Incremented by `markUpdated()`. */
  version = 0;
  position: Attribute<Float32Array>;
  normal: Attribute<Float32Array>;
  tangent?: Attribute<Float32Array>;
  uv?: Attribute<Float32Array>;
  /** Secondary UV set (glTF TEXCOORD_1 / Three.js uv1). */
  uv1?: Attribute<Float32Array>;
  color?: Attribute<Float32Array>;
  indices: Attribute<Uint16Array | Uint32Array>;
  materialIndex?: Attribute<Int32Array>;

  /** Bottom-level BVH, built automatically before rendering. @internal */
  bvh?: FlattendBVH;

  boundingBox = {
    min: vec3.create(),
    max: vec3.create()
  };
  constructor(data?: Partial<GeometryData>) {
    data = data || {};
    // TODO
    this.indices = data.indices!;
    this.position = data.position!;
    this.normal = data.normal!;

    this.tangent = data.tangent;
    this.uv = data.uv;
    this.uv1 = data.uv1;
    this.color = data.color;
    this.materialIndex = data.materialIndex;
  }

  /**
   * Call after editing attribute arrays in place. The BVH is refit or rebuilt
   * on the next frame; also call `renderer.markMeshesDirty()`.
   */
  markUpdated() {
    this.version++;
    return this;
  }

  static getVertexCount(geo: Geometry) {
    return geo.position.array.length / geo.position.itemSize;
  }

  static packMaterialIndexAndWeightToInt(index: number, weight: number) {
    return Math.round(weight * 255) + (index << 8);
  }

  static unpackMaterialIndexAndWeightFromInt(int: number) {
    return [int >> 8, (int & 0xff) / 255];
  }
}
