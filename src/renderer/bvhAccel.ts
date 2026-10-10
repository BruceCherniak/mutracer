// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

// Bounding volume hierarchies of scene geometry (BLAS) and mesh instances
// (TLAS), built with the binned SAH builder in ./binnedSahBvh and written
// directly in the BVH2 layout read by the traversal shaders.

import Geometry, { Attribute } from '../scene/Geometry.js';
import { mat4, vec3 } from '../math.js';
import { Mat4Array } from '../math.js';
import { buildBinnedSahBvh, layoutBvh2 } from './binnedSahBvh.js';

const vec3Min = vec3.min;
const vec3Max = vec3.max;

export const INSTANCE_VEC4_STRIDE = 9;
export const INSTANCE_WORD_STRIDE = INSTANCE_VEC4_STRIDE * 4;

export type BvhLayout = 'bvh2' | 'bvh4' | 'bvh-gpu' | 'cwbvh';

export interface FlattendBVH {
  /** CPU builder that produced the GPU traversal data. */
  builder?: 'builtin' | 'tinybvh';
  buildSurfaceArea?: number;
  maxDepth: number;
  /** Largest leaf fan-out; used with maxDepth to size the traversal stack. */
  maxLeafPrimitives?: number;
  buffer: ArrayBuffer;
  /** Precomputed data without a layout field uses the legacy BVH2 layout. */
  layout?: BvhLayout;

  instancesBuffer?: ArrayBuffer;
}

const BLAS_LAYOUT_SHIFT = 30;
const BLAS_OFFSET_MASK = 0x3fffffff;
const blasLayoutCodes: Record<BvhLayout, number> = {
  bvh2: 0,
  bvh4: 1,
  'bvh-gpu': 2,
  cwbvh: 3
};

function encodeBlasOffset(offset: number, layout: BvhLayout) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > BLAS_OFFSET_MASK) {
    throw new Error(`BLAS offset ${offset} exceeds the packed 30-bit range`);
  }
  return (offset | (blasLayoutCodes[layout] << BLAS_LAYOUT_SHIFT)) | 0;
}

export class Box3 {
  min: vec3.Vec3Array;
  max: vec3.Vec3Array;

  constructor() {
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
  }
}

function unionBounds(bounds: Box3, a: Box3, b: Box3) {
  vec3Min(bounds.min, a.min, b.min);
  vec3Max(bounds.max, a.max, b.max);
  return bounds;
}

export interface TLASInstance {
  blasIndex: number;
  bounds: Box3;
  transform: Mat4Array;
  materialsIndices: number[];
  displacementScale?: number;
}

export interface BLASInstance {
  bvh: FlattendBVH;
  trainglesCount: number;
  verticesCount: number;
}

// Keep a bounded specialization range for unusually deep hierarchies while
// allowing large TinyBVH converted builds (for example Mustang_Red requires 51).
// WebGPU still specializes each TLAS/BLAS stack to the scene's exact need.
export const MAX_TRAVERSAL_STACK_SIZE = 64;

export interface TraversalStackSizes {
  tlas: number;
  blas: number;
}

/**
 * Sizes independent TLAS and BLAS stacks for the nested WebGPU traversal.
 * A TLAS leaf is consumed in place, so its instance fan-out no longer needs
 * pending stack entries. TinyBVH converted layouts store their exact stack
 * requirement in maxDepth; BVH2 stores its tree depth.
 */
export function getTraversalStackSizes(
  tlas: FlattendBVH,
  blases: readonly BLASInstance[]
): TraversalStackSizes {
  return {
    tlas: Math.min(
      MAX_TRAVERSAL_STACK_SIZE,
      Math.max(1, tlas.maxDepth)
    ),
    blas: Math.min(
      MAX_TRAVERSAL_STACK_SIZE,
      blases.reduce(
        (stackSize, blas) => Math.max(stackSize, blas.bvh.maxDepth),
        1
      )
    )
  };
}

export function concatBLASBuffers(blases: BLASInstance[]): ArrayBuffer {
  const buffers = blases.map((blas) => new Float32Array(blas.bvh.buffer));
  const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (let i = 0; i < blases.length; i++) {
    result.set(buffers[i], offset);
    offset += buffers[i].length;
  }
  return result.buffer;
}

function packH(minH: number, maxH: number): number {
  const roundedMinH = Math.min(Math.floor(minH * 255), 255);
  const roundedMaxH =
    Math.abs(maxH - minH) < 1e-6
      ? roundedMinH
      : Math.min(Math.ceil(maxH * 255), 255);
  return (roundedMinH << 8) + roundedMaxH;
}

/** Writes min and max of a triangle, or of its displacement prism, to out. */
function triangleBounds(
  positions: ArrayLike<number>,
  stride: number,
  normals: ArrayLike<number> | undefined,
  normalStride: number,
  i0: number,
  i1: number,
  i2: number,
  minHeight: number,
  maxHeight: number,
  out: Float32Array,
  o: number
) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let corner = 0; corner < 3; corner++) {
    const vertex = corner === 0 ? i0 : corner === 1 ? i1 : i2;
    const p = vertex * stride;
    const x = positions[p], y = positions[p + 1], z = positions[p + 2];
    if (normals) {
      const n = vertex * normalStride;
      let nx = normals[n], ny = normals[n + 1], nz = normals[n + 2];
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (length > 0) {
        nx /= length; ny /= length; nz /= length;
      }
      for (let side = 0; side < 2; side++) {
        const h = side === 0 ? minHeight : maxHeight;
        const px = x + nx * h, py = y + ny * h, pz = z + nz * h;
        minX = Math.min(minX, px); minY = Math.min(minY, py); minZ = Math.min(minZ, pz);
        maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); maxZ = Math.max(maxZ, pz);
      }
    } else {
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    }
  }
  out[o] = minX; out[o + 1] = minY; out[o + 2] = minZ;
  out[o + 3] = maxX; out[o + 4] = maxY; out[o + 5] = maxZ;
  return isFinite(minX) && isFinite(minY) && isFinite(minZ) &&
    isFinite(maxX) && isFinite(maxY) && isFinite(maxZ);
}

function emptyBvh(isTLAS: boolean): FlattendBVH {
  return {
    builder: 'builtin',
    buildSurfaceArea: isTLAS ? undefined : 0,
    maxDepth: 0,
    maxLeafPrimitives: 0,
    buffer: new ArrayBuffer(0),
    layout: 'bvh2',
    instancesBuffer: isTLAS ? new ArrayBuffer(0) : undefined
  };
}

/** BLAS without triangles. */
export function emptyBLAS() {
  return emptyBvh(false);
}

/**
 * Builds a BVH2 BLAS over the geometry's triangles. Triangles with
 * non-finite bounds are skipped. With per-triangle displacement ranges
 * (min, max pairs scaled by displacementScale), leaves bound the
 * displacement prisms along the vertex normals and store the packed ranges.
 */
export function buildBLAS(
  geometry: Pick<Geometry, 'position' | 'indices' | 'normal'>,
  displacementScale = 0,
  trianglesDisplacement?: Float32Array
): FlattendBVH {
  const position = geometry.position;
  const indices = geometry.indices?.array;
  if (!position || !indices || !Attribute.getCount(position)) {
    return emptyBvh(false);
  }
  const positions = position.array;
  const stride = position.itemSize;
  const normal = trianglesDisplacement ? geometry.normal : undefined;
  const normals = normal?.array;
  const normalStride = normal?.itemSize ?? 0;
  const triangleCount = Math.floor(indices.length / 3);
  const aabbs = new Float32Array(triangleCount * 6);
  const triangles = new Uint32Array(triangleCount);
  let count = 0;
  for (let t = 0; t < triangleCount; t++) {
    let minHeight = 0, maxHeight = 0;
    if (normals) {
      minHeight = trianglesDisplacement![t * 2] * displacementScale;
      maxHeight = trianglesDisplacement![t * 2 + 1] * displacementScale;
      if (isNaN(minHeight) || isNaN(maxHeight)) {
        minHeight = 0;
        maxHeight = displacementScale;
      }
    }
    if (triangleBounds(
      positions, stride, normals, normalStride,
      indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2],
      minHeight, maxHeight, aabbs, count * 6
    )) {
      triangles[count++] = t;
    }
  }
  if (!count) return emptyBvh(false);

  const bvh = buildBinnedSahBvh(aabbs, count);
  const { order, offsets, vec4Count, maxDepth, maxLeafPrimitives } = layoutBvh2(bvh);
  const { bounds, leftFirst, primCount, primIndices } = bvh;
  const buffer = new ArrayBuffer(vec4Count * 16);
  const floats = new Float32Array(buffer);
  const ints = new Int32Array(buffer);
  let buildSurfaceArea = 0;
  for (let k = 0; k < order.length; k++) {
    const node = order[k];
    const o = offsets[node] * 4, b = node * 6;
    floats[o] = bounds[b]; floats[o + 1] = bounds[b + 1]; floats[o + 2] = bounds[b + 2];
    floats[o + 4] = bounds[b + 3]; floats[o + 5] = bounds[b + 4]; floats[o + 6] = bounds[b + 5];
    const x = bounds[b + 3] - bounds[b], y = bounds[b + 4] - bounds[b + 1], z = bounds[b + 5] - bounds[b + 2];
    buildSurfaceArea += 2 * (x * z + x * y + z * y);
    const prims = primCount[node];
    if (!prims) {
      // Pointer to the second child.
      ints[o + 3] = offsets[leftFirst[node] + 1];
      continue;
    }
    // Negative signals to the shader that this node is a leaf.
    ints[o + 3] = -prims;
    for (let i = 0; i < prims; i++) {
      const t = triangles[primIndices[leftFirst[node] + i]];
      const e = o + 8 + i * 4;
      ints[e] = indices[t * 3];
      ints[e + 1] = indices[t * 3 + 1];
      ints[e + 2] = indices[t * 3 + 2];
      // Pack minH, maxH to one channel.
      ints[e + 3] = trianglesDisplacement
        ? packH(trianglesDisplacement[t * 2], trianglesDisplacement[t * 2 + 1])
        : 0;
    }
  }

  return {
    builder: 'builtin',
    buildSurfaceArea,
    maxDepth,
    maxLeafPrimitives,
    buffer,
    layout: 'bvh2'
  };
}

interface BlasPlacement {
  blasOffsets: number[];
  vertexOffsets: number[];
  layouts: BvhLayout[];
}

function getBlasPlacement(blases: BLASInstance[]): BlasPlacement {
  let blasOffset = 0;
  let vertexOffset = 0;
  const placement: BlasPlacement = { blasOffsets: [], vertexOffsets: [], layouts: [] };
  blases.forEach((blas) => {
    placement.blasOffsets.push(blasOffset);
    placement.vertexOffsets.push(vertexOffset);
    placement.layouts.push(blas.bvh.layout ?? 'bvh2');
    blasOffset += blas.bvh.buffer.byteLength / 16;
    vertexOffset += blas.verticesCount;
  });
  return placement;
}

/** Writes the instance's world bounds, padded by its displacement, to out. */
function instanceBounds(instance: TLASInstance, out: Float32Array, o: number) {
  const { min, max } = instance.bounds;
  let padX = 0, padY = 0, padZ = 0;
  const displacementScale = instance.displacementScale;
  if (displacementScale) {
    const m = instance.transform;
    padX = Math.max(0, displacementScale * Math.hypot(m[0], m[1], m[2]));
    padY = Math.max(0, displacementScale * Math.hypot(m[4], m[5], m[6]));
    padZ = Math.max(0, displacementScale * Math.hypot(m[8], m[9], m[10]));
  }
  out[o] = min[0] - padX; out[o + 1] = min[1] - padY; out[o + 2] = min[2] - padZ;
  out[o + 3] = max[0] + padX; out[o + 4] = max[1] + padY; out[o + 5] = max[2] + padZ;
}

function writeInstanceRecord(
  instanceInts: Int32Array,
  instanceFloats: Float32Array,
  targetIndex: number,
  instance: TLASInstance,
  placement: BlasPlacement
) {
  const offset = targetIndex * INSTANCE_WORD_STRIDE;
  instanceInts[offset] = encodeBlasOffset(
    placement.blasOffsets[instance.blasIndex],
    placement.layouts[instance.blasIndex]
  );
  instanceInts[offset + 1] = placement.vertexOffsets[instance.blasIndex];
  instanceInts[offset + 2] = instance.materialsIndices[0] || 0;
  instanceFloats[offset + 3] = instance.displacementScale || 0;
  const inverse = mat4.invert(mat4.create(), instance.transform);
  for (let i = 0; i < 16; i++) {
    instanceFloats[offset + 4 + i] = inverse[i];
    instanceFloats[offset + 20 + i] = instance.transform[i];
  }
}

/**
 * Builds a BVH2 TLAS over the instances. Leaves store
 * (instance record, BLAS offset, source instance index, 0); instance records
 * are written in leaf order to instancesBuffer.
 */
export function buildTLAS(
  instances: TLASInstance[],
  blases: BLASInstance[]
): FlattendBVH {
  if (!instances.length) return emptyBvh(true);
  const placement = getBlasPlacement(blases);
  const aabbs = new Float32Array(instances.length * 6);
  for (let i = 0; i < instances.length; i++) {
    instanceBounds(instances[i], aabbs, i * 6);
  }

  const bvh = buildBinnedSahBvh(aabbs, instances.length);
  const { order, offsets, vec4Count, maxDepth, maxLeafPrimitives } = layoutBvh2(bvh);
  const { bounds, leftFirst, primCount, primIndices } = bvh;
  const buffer = new ArrayBuffer(vec4Count * 16);
  const floats = new Float32Array(buffer);
  const ints = new Int32Array(buffer);
  const instancesBuffer = new ArrayBuffer(instances.length * INSTANCE_WORD_STRIDE * 4);
  const instanceInts = new Int32Array(instancesBuffer);
  const instanceFloats = new Float32Array(instancesBuffer);
  let target = 0;
  for (let k = 0; k < order.length; k++) {
    const node = order[k];
    const o = offsets[node] * 4, b = node * 6;
    floats[o] = bounds[b]; floats[o + 1] = bounds[b + 1]; floats[o + 2] = bounds[b + 2];
    floats[o + 4] = bounds[b + 3]; floats[o + 5] = bounds[b + 4]; floats[o + 6] = bounds[b + 5];
    const prims = primCount[node];
    if (!prims) {
      ints[o + 3] = offsets[leftFirst[node] + 1];
      continue;
    }
    ints[o + 3] = -prims;
    for (let i = 0; i < prims; i++) {
      const source = primIndices[leftFirst[node] + i];
      const instance = instances[source];
      const e = o + 8 + i * 4;
      ints[e] = target;
      ints[e + 1] = placement.blasOffsets[instance.blasIndex];
      // Keep the source instance index in the otherwise-unused z lane so
      // the TLAS can be refitted without rebuilding its topology.
      ints[e + 2] = source;
      writeInstanceRecord(instanceInts, instanceFloats, target, instance, placement);
      target++;
    }
  }

  return {
    builder: 'builtin',
    maxDepth,
    maxLeafPrimitives,
    buffer,
    layout: 'bvh2',
    instancesBuffer
  };
}

export interface TLASRefitRange {
  offset: number;
  size: number;
}

export interface TLASRefitResult {
  tlasRanges: TLASRefitRange[];
  instanceRanges: TLASRefitRange[];
}

interface TLASRefitMetadata {
  parent: Map<number, number>;
  depth: Map<number, number>;
  leavesBySource: Map<number, Set<number>>;
  instancesByLeaf: Map<number, { source: number; target: number }[]>;
}

const tlasRefitMetadata = new WeakMap<FlattendBVH, TLASRefitMetadata>();

function getTLASRefitMetadata(flattened: FlattendBVH, ints: Int32Array) {
  const cached = tlasRefitMetadata.get(flattened);
  if (cached) return cached;
  const metadata: TLASRefitMetadata = {
    parent: new Map(),
    depth: new Map(),
    leavesBySource: new Map(),
    instancesByLeaf: new Map()
  };
  const visit = (index: number, parent: number | undefined, depth: number) => {
    metadata.depth.set(index, depth);
    if (parent != null) metadata.parent.set(index, parent);
    const base = index * 4;
    const primitiveCountOrChild = ints[base + 3];
    if (primitiveCountOrChild >= 0) {
      visit(index + 2, index, depth + 1);
      visit(primitiveCountOrChild, index, depth + 1);
      return;
    }
    const entries: { source: number; target: number }[] = [];
    for (let i = 0; i < -primitiveCountOrChild; i++) {
      const primitiveOffset = base + 8 + i * 4;
      const target = ints[primitiveOffset];
      const source = ints[primitiveOffset + 2];
      entries.push({ source, target });
      const leaves = metadata.leavesBySource.get(source) ?? new Set<number>();
      leaves.add(index);
      metadata.leavesBySource.set(source, leaves);
    }
    metadata.instancesByLeaf.set(index, entries);
  };
  visit(0, undefined, 0);
  tlasRefitMetadata.set(flattened, metadata);
  return metadata;
}

export function mergeRefitRanges(ranges: TLASRefitRange[]) {
  const sorted = ranges
    .filter(({ size }) => size > 0)
    .sort((left, right) => left.offset - right.offset);
  const merged: TLASRefitRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.offset <= previous.offset + previous.size) {
      previous.size = Math.max(
        previous.size,
        range.offset + range.size - previous.offset
      );
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function refitTLAS(
  flattened: FlattendBVH,
  instances: TLASInstance[],
  blases: BLASInstance[],
  dirtySourceIndices?: ReadonlySet<number>
): TLASRefitResult {
  if (!flattened.instancesBuffer || !flattened.buffer.byteLength) {
    return { tlasRanges: [], instanceRanges: [] };
  }
  const floats = new Float32Array(flattened.buffer);
  const ints = new Int32Array(flattened.buffer);
  const instanceFloats = new Float32Array(flattened.instancesBuffer);
  const instanceInts = new Int32Array(flattened.instancesBuffer);

  const placement = getBlasPlacement(blases);
  const scratch = new Float32Array(6);

  function writeInstance(targetIndex: number, sourceIndex: number) {
    writeInstanceRecord(instanceInts, instanceFloats, targetIndex, instances[sourceIndex], placement);
  }

  function addInstanceBounds(bounds: Box3, instance: TLASInstance) {
    instanceBounds(instance, scratch, 0);
    bounds.min[0] = Math.min(bounds.min[0], scratch[0]);
    bounds.min[1] = Math.min(bounds.min[1], scratch[1]);
    bounds.min[2] = Math.min(bounds.min[2], scratch[2]);
    bounds.max[0] = Math.max(bounds.max[0], scratch[3]);
    bounds.max[1] = Math.max(bounds.max[1], scratch[4]);
    bounds.max[2] = Math.max(bounds.max[2], scratch[5]);
  }

  function writeNodeBounds(index: number, bounds: Box3) {
    const base = index * 4;
    floats[base] = bounds.min[0];
    floats[base + 1] = bounds.min[1];
    floats[base + 2] = bounds.min[2];
    floats[base + 4] = bounds.max[0];
    floats[base + 5] = bounds.max[1];
    floats[base + 6] = bounds.max[2];
  }

  function readNodeBounds(index: number) {
    const base = index * 4;
    const bounds = new Box3();
    vec3.set(bounds.min, floats[base], floats[base + 1], floats[base + 2]);
    vec3.set(
      bounds.max,
      floats[base + 4],
      floats[base + 5],
      floats[base + 6]
    );
    return bounds;
  }

  function refitNode(index: number): Box3 {
    const base = index * 4;
    const bounds = new Box3();
    const primitiveCountOrChild = ints[base + 3];
    if (primitiveCountOrChild >= 0) {
      const left = refitNode(index + 2);
      const right = refitNode(primitiveCountOrChild);
      unionBounds(bounds, left, right);
    } else {
      for (let i = 0; i < -primitiveCountOrChild; i++) {
        const primitiveOffset = base + 8 + i * 4;
        const targetInstance = ints[primitiveOffset];
        const sourceInstance = ints[primitiveOffset + 2];
        const instance = instances[sourceInstance];
        if (!instance) continue;
        addInstanceBounds(bounds, instance);
        writeInstance(targetInstance, sourceInstance);
      }
    }
    writeNodeBounds(index, bounds);
    return bounds;
  }

  if (!dirtySourceIndices) {
    refitNode(0);
    return {
      tlasRanges: [{ offset: 0, size: flattened.buffer.byteLength }],
      instanceRanges: [
        { offset: 0, size: flattened.instancesBuffer.byteLength }
      ]
    };
  }

  const metadata = getTLASRefitMetadata(flattened, ints);
  const dirtyLeaves = new Set<number>();
  const instanceRanges: TLASRefitRange[] = [];
  for (const source of dirtySourceIndices) {
    const leaves = metadata.leavesBySource.get(source);
    if (!leaves) continue;
    leaves.forEach((leaf) => dirtyLeaves.add(leaf));
    for (const leaf of leaves) {
      for (const entry of metadata.instancesByLeaf.get(leaf) ?? []) {
        if (entry.source !== source) continue;
        writeInstance(entry.target, source);
        instanceRanges.push({ offset: entry.target * INSTANCE_WORD_STRIDE * 4, size: INSTANCE_WORD_STRIDE * 4 });
      }
    }
  }

  const dirtyNodes = new Set<number>();
  for (const leaf of dirtyLeaves) {
    const bounds = new Box3();
    for (const { source } of metadata.instancesByLeaf.get(leaf) ?? []) {
      const instance = instances[source];
      if (instance) addInstanceBounds(bounds, instance);
    }
    writeNodeBounds(leaf, bounds);
    dirtyNodes.add(leaf);
    let parent = metadata.parent.get(leaf);
    while (parent != null) {
      dirtyNodes.add(parent);
      parent = metadata.parent.get(parent);
    }
  }

  const internalNodes = [...dirtyNodes]
    .filter((index) => ints[index * 4 + 3] >= 0)
    .sort(
      (left, right) =>
        (metadata.depth.get(right) ?? 0) - (metadata.depth.get(left) ?? 0)
    );
  for (const index of internalNodes) {
    const right = ints[index * 4 + 3];
    const bounds = new Box3();
    unionBounds(bounds, readNodeBounds(index + 2), readNodeBounds(right));
    writeNodeBounds(index, bounds);
  }

  return {
    tlasRanges: mergeRefitRanges(
      [...dirtyNodes].map((index) => ({ offset: index * 16, size: 32 }))
    ),
    instanceRanges: mergeRefitRanges(instanceRanges)
  };
}

/** Dynamic BLASes rebuild when their total node surface area doubles. */
export const DYNAMIC_BLAS_REBUILD_RATIO = 2;

interface BlasRefitData {
  /** Per leaf (vec4 index): offset of its vertex list in vertices. */
  offsets: Int32Array;
  /** Per leaf: unique vertex count followed by the vertices. */
  vertices: Uint32Array;
  /** Node indices (vec4 units) with descendants before their ancestors. */
  postorder: Int32Array;
}

// Leaf topology is immutable between BLAS builds. Deduplicate shared triangle
// corners once so deformation refits read each leaf's vertex only once.
const blasRefitData = new WeakMap<ArrayBuffer, BlasRefitData>();

function getBlasRefitData(buffer: ArrayBuffer): BlasRefitData {
  const cached = blasRefitData.get(buffer);
  if (cached) return cached;
  const ints = new Int32Array(buffer);
  const offsets = new Int32Array(ints.length / 4);
  const vertices: number[] = [];
  const preorder: number[] = [];
  const stack = [0];
  while (stack.length) {
    const index = stack.pop()!;
    preorder.push(index);
    const base = index * 4;
    const child = ints[base + 3];
    if (child >= 0) {
      stack.push(child, index + 2);
      continue;
    }
    offsets[index] = vertices.length;
    const countSlot = vertices.length;
    vertices.push(0);
    for (let i = 0; i < -child; i++) {
      for (let j = 0; j < 3; j++) {
        const vertex = ints[base + 8 + i * 4 + j];
        let seen = false;
        for (let k = countSlot + 1; k < vertices.length; k++) {
          if (vertices[k] === vertex) { seen = true; break; }
        }
        if (!seen) vertices.push(vertex);
      }
    }
    vertices[countSlot] = vertices.length - countSlot - 1;
  }
  const data = {
    offsets,
    vertices: new Uint32Array(vertices),
    postorder: new Int32Array(preorder.reverse())
  };
  blasRefitData.set(buffer, data);
  return data;
}

/** Refit a BVH2 BLAS after vertex deformation, preserving topology. */
export function refitBLAS(
  flattened: FlattendBVH,
  geometry: Pick<Geometry, 'position'> & Partial<Pick<Geometry, 'dynamic'>>
) {
  if ((flattened.layout ?? 'bvh2') !== 'bvh2' || !flattened.buffer.byteLength) {
    return false;
  }
  const { offsets, vertices, postorder } = getBlasRefitData(flattened.buffer);
  const floats = new Float32Array(flattened.buffer), ints = new Int32Array(flattened.buffer);
  const positions = geometry.position.array, stride = geometry.position.itemSize;
  if (flattened.buildSurfaceArea == null) {
    let area = 0;
    for (const index of postorder) {
      const b = index * 4;
      const x = floats[b + 4] - floats[b], y = floats[b + 5] - floats[b + 1], z = floats[b + 6] - floats[b + 2];
      area += 2 * (x * z + x * y + z * y);
    }
    flattened.buildSurfaceArea = area;
  }
  let area = 0;
  for (let node = 0; node < postorder.length; node++) {
    const index = postorder[node], base = index * 4, child = ints[base + 3];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    if (child >= 0) {
      const left = base + 8, right = child * 4;
      minX = Math.min(floats[left], floats[right]); minY = Math.min(floats[left + 1], floats[right + 1]); minZ = Math.min(floats[left + 2], floats[right + 2]);
      maxX = Math.max(floats[left + 4], floats[right + 4]); maxY = Math.max(floats[left + 5], floats[right + 5]); maxZ = Math.max(floats[left + 6], floats[right + 6]);
    } else {
      const start = offsets[index], end = start + 1 + vertices[start];
      for (let i = start + 1; i < end; i++) {
        const offset = vertices[i] * stride;
        const x = positions[offset], y = positions[offset + 1], z = positions[offset + 2];
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      }
    }
    const x = maxX - minX, y = maxY - minY, z = maxZ - minZ;
    area += 2 * (x * z + x * y + z * y);
    floats[base] = minX; floats[base + 1] = minY; floats[base + 2] = minZ;
    floats[base + 4] = maxX; floats[base + 5] = maxY; floats[base + 6] = maxZ;
  }
  return !geometry.dynamic || !(area > flattened.buildSurfaceArea * DYNAMIC_BLAS_REBUILD_RATIO);
}
