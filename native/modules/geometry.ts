import Geometry, { Attribute } from '../../src/scene/Geometry.js';
import { attributeLength, attributeValue, type AttributeData } from '../../src/scene/attributeData.js';
import { read } from '../../src/math/access.js';
import { createSphereGeometry, createPlaneGeometry, createCubeGeometry, createCurvePlaneGeometry } from '../../src/util/commonGeometry.js';

function attributeParameters<T extends AttributeData>(attribute: Attribute<T>, output: Float32Array, offset: number) {
  output[offset] = Attribute.getCount(attribute);
  const item: number[] = [];
  Attribute.getItem(attribute, item, 0);
  output.set(item, offset + 1);
}

/** Module byte entry: shape:u32 (sphere/plane/cube/cove/raw/u16), segments:u32.
 * Output contains header, all positions/normals/UVs/indices and local bounds.
 */
export function geometryParameters(bytes: Uint8Array): Uint8Array {
  const input = new Uint32Array(bytes.buffer, bytes.byteOffset, 2);
  const shape = input[0], segments = input[1];
  let geometry: Geometry;
  if (shape === 0) geometry = createSphereGeometry(segments, 4);
  else if (shape === 1) geometry = createPlaneGeometry(segments, 2);
  else if (shape === 2) geometry = createCubeGeometry(segments, 2, 3);
  else if (shape === 3) geometry = createCurvePlaneGeometry(.2);
  else if (shape === 4) geometry = new Geometry({ position: new Attribute(new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]), 3) });
  else geometry = new Geometry({ position: new Attribute(new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]), 3), indices: new Attribute(new Uint16Array([0, 1, 2]), 1) });
  geometry.markVerticesUpdated(); geometry.markUpdated();
  const positions = geometry.position.array, normals = geometry.normal.array;
  const uv = geometry.uv?.array, indices = geometry.indices.array;
  const uvLength = uv ? uv.length : 0, indexLength = attributeLength(indices);
  const result = new ArrayBuffer((34 + positions.length + normals.length + uvLength + indexLength) * 4);
  const words = new Uint32Array(result), floats = new Float32Array(result);
  words.set([2, shape, geometry.vertexCount, geometry.triangleCount, positions.length, normals.length, uvLength, indexLength, geometry.version, geometry.topologyVersion]);
  for (let i = 0; i < 3; i++) {
    floats[10 + i] = read(geometry.boundingBox.min, i); floats[13 + i] = read(geometry.boundingBox.max, i);
  }
  let offset = 16;
  floats.set(positions, offset); offset += positions.length;
  floats.set(normals, offset); offset += normals.length;
  if (uv) { floats.set(uv, offset); offset += uv.length; }
  for (let i = 0; i < indexLength; i++) words[offset + i] = attributeValue(indices, i);
  offset += indexLength;
  attributeParameters(new Attribute(new Float32Array([1.25, -2.5, 3.75]), 3), floats, offset);
  attributeParameters(new Attribute(new Uint16Array([1, 255, 65535]), 3), floats, offset + 4);
  attributeParameters(new Attribute(new Uint32Array([1, 65536, 12345678]), 3), floats, offset + 8);
  attributeParameters(new Attribute(new Int32Array([-1, -255, 12345678]), 3), floats, offset + 12);
  const firstIndex: number[] = [];
  Attribute.getItem(geometry.indices, firstIndex, 0);
  floats[offset + 16] = Attribute.getCount(geometry.indices);
  floats[offset + 17] = firstIndex[0];
  return new Uint8Array(result);
}
