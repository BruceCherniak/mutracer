/// <reference path="../browser-types.d.ts" />
import Geometry, { Attribute } from '../../src/scene/Geometry.js';
import MaterialState from '../../src/scene/MaterialState.js';
import TextureState from '../../src/scene/TextureState.js';
import { attributeLength, attributeValue } from '../../src/scene/attributeData.js';
import { markDeformedGeometry } from '../../src/scene/geometryChanges.js';
import { createPlaneGeometry } from '../../src/util/commonGeometry.js';
import { generateVertexTangents } from '../../src/util/geometry.js';
import { read } from '../../src/math/access.js';
import { buildBLAS } from '../../src/renderer/bvhAccel.js';
import { setGeometryBvh } from '../../src/renderer/geometryBvh.js';
import { getBvhBounds } from '../../src/renderer/geometryBvhBounds.js';
import type { GeometryUpdateState, GeometryUpdateMesh } from '../../src/renderer/geometryUpdateState.js';
import { canUpdateGeometries, geometryTopologyChanged, packVertexAttributes,
  updatePreparedGeometries } from '../../src/renderer/geometryUpdates.js';

interface ProbeMesh extends GeometryUpdateMesh { id: number; }

export function geometryUpdateParameters(bytes: Uint8Array): Uint8Array {
  const input = new Uint32Array(bytes.buffer, bytes.byteOffset, 2);
  const flags = input[0], segments = input[1];
  const source = createPlaneGeometry(segments, segments), other = createPlaneGeometry();
  source.dynamic = !!(flags & 1);
  if (flags & 16) {
    const data = new Uint16Array(attributeLength(source.indices.array));
    for (let i = 0; i < data.length; i++) data[i] = attributeValue(source.indices.array, i);
    source.indices = new Attribute(data, 1);
  }
  if (flags & 64) generateVertexTangents(source);
  const count = source.vertexCount + other.vertexCount;
  const merged = new Geometry({
    position: new Attribute(new Float32Array(count * 3), 3),
    normal: new Attribute(new Float32Array(count * 3), 3),
    uv: new Attribute(new Float32Array(count * 2), 2),
    uv1: new Attribute(new Float32Array(count * 2), 2),
    color: new Attribute(new Float32Array(count * 3), 3),
    tangent: new Attribute(new Float32Array(count * 4), 4),
    materialIndex: new Attribute(new Int32Array(count * 4).fill(123), 4),
    indices: new Attribute(new Uint32Array(attributeLength(source.indices.array) + attributeLength(other.indices.array)), 1)
  });
  merged.position.array.set(source.position.array); merged.position.array.set(other.position.array, source.vertexCount * 3);
  merged.normal.array.set(source.normal.array); merged.normal.array.set(other.normal.array, source.vertexCount * 3);
  const material = new MaterialState();
  const a: ProbeMesh = {geometry: source, materials: [material], id: 1};
  const b: ProbeMesh = {geometry: source, materials: [material], id: 2};
  const c: ProbeMesh = {geometry: other, materials: [material], id: 3};
  const initial = buildBLAS(source), untouched = buildBLAS(other);
  setGeometryBvh(source, initial); setGeometryBvh(other, untouched);
  const prepared: GeometryUpdateState<ProbeMesh> = {
    geometry: merged, geometries: [source, other],
    geometryRegions: new Map([
      [source, {vertexOffset: 0, indexOffset: 0, materialIndices: [3]}],
      [other, {vertexOffset: source.vertexCount, indexOffset: attributeLength(source.indices.array), materialIndices: [7]}]
    ]),
    geometryStates: new Map([
      [source, {topologyVersion: source.topologyVersion, indices: source.indices.array, indexCount: attributeLength(source.indices.array)}],
      [other, {topologyVersion: other.topologyVersion, indices: other.indices.array, indexCount: attributeLength(other.indices.array)}]
    ]),
    instanceBindings: [
      {mesh: a, geometry: source, bvhBounds: getBvhBounds(source)},
      {mesh: b, geometry: source, bvhBounds: getBvhBounds(source)},
      {mesh: c, geometry: other, bvhBounds: getBvhBounds(other)}
    ],
    blases: [{bvh: initial}, {bvh: untouched}]
  };
  if (flags & 32) material.displacementMap = new TextureState({width: 1, height: 1});
  source.position.array[0] += .125; source.normal.array[0] = .25;
  if (source.uv) source.uv.array[0] = .75;
  if (flags & 2) {
    const indices = source.indices.array;
    if (indices instanceof Uint16Array) indices.fill(0); else indices.fill(0);
    source.markUpdated();
  }
  else if (flags & 4) markDeformedGeometry(source);
  else source.markVerticesUpdated();
  if (flags & 8) {
    const data = new Uint32Array(attributeLength(source.indices.array));
    for (let i = 0; i < data.length; i++) data[i] = attributeValue(source.indices.array, i);
    source.indices = new Attribute(data, 1);
  }
  const eligible = canUpdateGeometries(prepared, [source]);
  const beforeTopology = geometryTopologyChanged(prepared, source);
  const update = updatePreparedGeometries(prepared, eligible ? new Set([source]) : new Set<Geometry>());
  const packed = new Float32Array(count * 24).fill(-99);
  packVertexAttributes(merged, packed, 24, [0, 4, 8, 10, 12, 16, 20], 0, count);
  const metadata: number[] = [eligible ? 1 : 0, beforeTopology ? 1 : 0,
    geometryTopologyChanged(prepared, source) ? 1 : 0, update.resized ? 1 : 0,
    update.relocated ? 1 : 0, update.vertices.length, update.blases.length, update.meshes.size,
    prepared.blases[0].bvh === initial ? 1 : 0, prepared.blases[1].bvh === untouched ? 1 : 0];
  for (const range of update.vertices) metadata.push(range.first, range.count, Number(range.topologyChanged), Number(range.deformationOnly));
  for (const mesh of update.meshes) metadata.push(mesh.id);
  for (const binding of prepared.instanceBindings) for (const bound of binding.bvhBounds) {
    for (let i = 0; i < 3; i++) metadata.push(read(bound, i));
  }
  const mergedIndices = merged.indices.array;
  const indexBytes = new Uint8Array(mergedIndices instanceof Uint16Array ? mergedIndices.buffer : mergedIndices.buffer);
  const header = new Uint32Array(8 + metadata.length);
  header.set([1, metadata.length, packed.byteLength, prepared.blases[0].bvh.buffer.byteLength,
    prepared.blases[1].bvh.buffer.byteLength, indexBytes.byteLength, merged.materialIndex!.array.byteLength, 0]);
  const values = new Float32Array(header.buffer, 32, metadata.length); values.set(metadata);
  const parts = [new Uint8Array(header.buffer), new Uint8Array(packed.buffer),
    new Uint8Array(prepared.blases[0].bvh.buffer), new Uint8Array(prepared.blases[1].bvh.buffer),
    indexBytes,
    new Uint8Array(merged.materialIndex!.array.buffer)];
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
