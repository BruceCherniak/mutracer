import { buildBLAS, buildTLAS, refitBLAS, refitTLAS, updateTLASInstanceColors,
  concatBLASBuffers, getTraversalStackSizes, emptyBLAS, Box3,
  type FlattendBVH, type TLASInstance, type TLASRefitRange } from '../../../src/renderer/bvhAccel.js';
import { PackedMeshInstances, sameInstanceMembership, meshInstancesLength } from '../../../src/renderer/packedMeshInstances.js';
import { createPlaneGeometry, createSphereGeometry } from '../../../src/util/commonGeometry.js';
import { Attribute } from '../../../src/scene/Geometry.js';
import { attributeValue, attributeLength } from '../../../src/scene/attributeData.js';
import { mat4 } from '../../../src/math.js';
import { read, write } from '../../../src/math/access.js';

function snapshot(buffers: ArrayBuffer[], bvh: FlattendBVH) {
  buffers.push(new Float64Array([bvh.maxDepth, bvh.maxLeafPrimitives ?? 0,
    bvh.buildSurfaceArea ?? -1, bvh.buffer.byteLength, bvh.instancesBuffer?.byteLength ?? 0]).buffer);
  buffers.push(bvh.buffer.slice(0));
  if (bvh.instancesBuffer) buffers.push(bvh.instancesBuffer.slice(0));
}

function ranges(buffers: ArrayBuffer[], values: TLASRefitRange[]) {
  const output = new Uint32Array(1 + values.length * 2);
  output[0] = values.length;
  for (let i = 0; i < values.length; i++) {
    output[1 + i * 2] = values[i].offset;
    output[2 + i * 2] = values[i].size;
  }
  buffers.push(output.buffer);
}

/** BVH facade byte probe; construction and updates execute AOT. */
export function bvhParameters(bytes: Uint8Array): Uint8Array {
  const input = new Uint32Array(bytes.buffer, bytes.byteOffset, 4);
  const count = input[0], segments = input[1], flags = input[2];
  const geometry = flags & 1 ? createSphereGeometry(segments, segments) : createPlaneGeometry(segments, segments);
  if (flags & 2) {
    const indices = geometry.indices.array, narrow = new Uint16Array(attributeLength(indices));
    for (let i = 0; i < narrow.length; i++) narrow[i] = attributeValue(indices, i);
    geometry.indices = new Attribute(narrow, 1);
  }
  if (flags & 4) geometry.position.array[0] = Infinity;
  const displacement = new Float32Array(geometry.triangleCount * 2);
  for (let i = 0; i < geometry.triangleCount; i++) {
    displacement[i * 2] = i % 3 === 0 ? NaN : .1;
    displacement[i * 2 + 1] = .8;
  }
  const buffers: ArrayBuffer[] = [];
  const blas = flags & 8 ? buildBLAS(geometry, .25, displacement) : buildBLAS(geometry);
  snapshot(buffers, emptyBLAS()); snapshot(buffers, blas);
  const blases = [{ bvh: blas, trainglesCount: geometry.triangleCount, verticesCount: geometry.vertexCount }];
  const instances: TLASInstance[] = [];
  const packed = new PackedMeshInstances(count); packed.length = count;
  for (let i = 0; i < count; i++) {
    const bounds = new Box3();
    for (let axis = 0; axis < 3; axis++) {
      write(bounds.min, axis, i * 2 - axis - 1);
      write(bounds.max, axis, i * 2 + axis + 1);
      packed.bounds[i * 6 + axis] = read(bounds.min, axis);
      packed.bounds[i * 6 + axis + 3] = read(bounds.max, axis);
    }
    const transform = mat4.create();
    transform[0] = 1 + i * .125; transform[5] = 1.5; transform[10] = .75;
    transform[12] = i * 2; transform[13] = -i;
    const instance: TLASInstance = { blasIndex: 0, bounds, transform,
      materialsIndices: [i], displacementScale: .25, color: [i * .125, .5, 1] };
    instances.push(instance);
    for (let k = 0; k < 16; k++) packed.transforms[i * 16 + k] = transform[k];
    packed.materials[i] = i; packed.displacement[i] = .25; packed.sourceIndices[i] = i;
    packed.colors[i * 3] = i * .125; packed.colors[i * 3 + 1] = .5; packed.colors[i * 3 + 2] = 1;
  }
  const tlas = buildTLAS(instances, blases), packedTlas = buildTLAS(packed, blases);
  snapshot(buffers, tlas); snapshot(buffers, packedTlas);
  const stacks = getTraversalStackSizes(tlas, blases);
  buffers.push(new Uint32Array([stacks.tlas, stacks.blas, meshInstancesLength(packed),
    sameInstanceMembership(packed, packed) ? 1 : 0, sameInstanceMembership(instances, packed) ? 1 : 0]).buffer);
  buffers.push(concatBLASBuffers(blases));
  const dirty = new Set<number>();
  if (count) {
    dirty.add(count - 1);
    const last = instances[count - 1];
    last.color = undefined;
    write(last.bounds.min, 0, read(last.bounds.min, 0) - .5);
    write(last.transform, 12, read(last.transform, 12) + .25);
  }
  ranges(buffers, updateTLASInstanceColors(tlas, instances, dirty));
  snapshot(buffers, tlas);
  const partial = refitTLAS(tlas, instances, blases, dirty);
  ranges(buffers, partial.tlasRanges); ranges(buffers, partial.instanceRanges);
  snapshot(buffers, tlas);
  const full = refitTLAS(tlas, instances, blases);
  ranges(buffers, full.tlasRanges); ranges(buffers, full.instanceRanges);
  snapshot(buffers, tlas);
  for (let i = 0; i < geometry.position.array.length; i++) geometry.position.array[i] *= input[3] ? 8 : 1.01;
  geometry.dynamic = !!input[3];
  const refitted = refitBLAS(blas, geometry);
  buffers.push(new Uint32Array([refitted ? 1 : 0]).buffer); snapshot(buffers, blas);
  let size = 0;
  for (const buffer of buffers) size += buffer.byteLength;
  const result = new Uint8Array(size);
  let offset = 0;
  for (const buffer of buffers) { result.set(new Uint8Array(buffer), offset); offset += buffer.byteLength; }
  return result;
}
