// Create a bounding volume hierarchy of scene geometry
// Uses the surface area heuristic (SAH) algorithm for efficient partitioning
// http://www.pbr-book.org/3ed-2018/Primitives_and_Intersection_Acceleration/Bounding_Volume_Hierarchies.html

import { partition, nthElement } from './bvhUtil';
import Geometry, { Attribute } from '../scene/Geometry';
import { mat4, vec3 } from '../math';
import { Mat4Array } from '../math';

// Cache the frequency used methods.
// In case after build the access brought extra costs.
const vec3Min = vec3.min;
const vec3Max = vec3.max;
const vec3Sub = vec3.sub;

interface PrimitiveInfo {
  center: vec3.Vec3Array;
  bounds: Box3;
  primitive: number;
}

interface BLASPrimitiveInfo extends PrimitiveInfo {
  indices: vec3.Vec3Array;
}
export const INSTANCE_VEC4_STRIDE = 10;
export const INSTANCE_WORD_STRIDE = INSTANCE_VEC4_STRIDE * 4;

interface TLASPrimitiveInfo extends PrimitiveInfo {
  sourceIndex: number;
  transform: Mat4Array;
  triangleOffset: number;
  vertexOffset: number;
  materialIndex: number;
  displacementScale: number;
  uvProjection: number;
  displacementUvProjection: number;
  blasLayout: BvhLayout;
}

interface InteriorNode {
  child0: InteriorNode | LeafNode;
  child1: InteriorNode | LeafNode;
  bounds: Box3;
  splitAxis: 0 | 1 | 2;
}

interface LeafNode {
  primitives: (BLASPrimitiveInfo | TLASPrimitiveInfo)[];
  bounds: Box3;
}

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

export function buildBLAS(
  geometry: Pick<Geometry, 'position' | 'indices' | 'normal'>,
  displacementScale: number,
  trianglesDisplacement: Float32Array | undefined
): InteriorNode | undefined {
  if (!Attribute.getCount(geometry.position)) {
    return undefined;
  }
  const primitiveInfo = makeBLASPrimitiveInfo(
    geometry,
    displacementScale,
    trianglesDisplacement
  );
  const node = recursiveBuild(primitiveInfo, 0, primitiveInfo.length);

  return node as InteriorNode;
}

export interface TLASInstance {
  blasIndex: number;
  bounds: Box3;
  transform: Mat4Array;
  materialsIndices: number[];
  displacementScale?: number;
  uvProjection?: number;
  displacementUvProjection?: number;
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
 * requirement in maxDepth; legacy BVH2 stores its tree depth.
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

export function buildTLAS(
  instances: TLASInstance[],
  blases: BLASInstance[]
): InteriorNode | undefined {
  if (!instances.length) {
    return undefined;
  }

  let vertexOffset = 0;
  let triangleOffset = 0;
  let blasOffset = 0;
  const blasOffsets: number[] = [];
  const vertexOffsets: number[] = [];
  const triangleOffsets: number[] = [];
  const blasLayouts: BvhLayout[] = [];

  blases.forEach((blas) => {
    blasOffsets.push(blasOffset);
    vertexOffsets.push(vertexOffset);
    triangleOffsets.push(triangleOffset);
    blasLayouts.push(blas.bvh.layout ?? 'bvh2');
    blasOffset += blas.bvh.buffer.byteLength / 16;
    vertexOffset += blas.verticesCount;
    triangleOffset += blas.trainglesCount;
  });

  const primitives = instances.map(
    (
      { blasIndex, bounds, transform, materialsIndices, displacementScale, uvProjection, displacementUvProjection },
      i
    ) => {
      const center = vec3.create();
      let min = vec3.clone(bounds.min);
      let max = vec3.clone(bounds.max);
      const scaleX = vec3.length(
        vec3.fromValues(transform[0], transform[1], transform[2])
      );
      const scaleY = vec3.length(
        vec3.fromValues(transform[4], transform[5], transform[6])
      );
      const scaleZ = vec3.length(
        vec3.fromValues(transform[8], transform[9], transform[10])
      );
      if (displacementScale) {
        let pad = vec3.fromValues(
          Math.max(0.0, displacementScale * scaleX),
          Math.max(0.0, displacementScale * scaleY),
          Math.max(0.0, displacementScale * scaleZ)
        );
        vec3.sub(min, min, pad);
        vec3.add(max, max, pad);
      }
      vec3.add(center, min, max);
      vec3.scale(center, center, 0.5);
      const ret = {
        sourceIndex: i,
        center,
        bounds: { min, max },
        primitive: blasOffsets[blasIndex],
        transform,
        vertexOffset: vertexOffsets[blasIndex],
        triangleOffset: triangleOffsets[blasIndex],
        materialIndex: materialsIndices[0] || 0,
        displacementScale: displacementScale || 0,
        uvProjection: uvProjection ?? -1,
        displacementUvProjection: displacementUvProjection ?? -1,
        blasLayout: blasLayouts[blasIndex]
      } satisfies TLASPrimitiveInfo;
      return ret;
    }
  );

  const node = recursiveBuild(primitives, 0, primitives.length);
  return node as InteriorNode;
}

function packH(minH: number, maxH: number): number {
  const roundedMinH = Math.min(Math.floor(minH * 255), 255);
  const roundedMaxH =
    Math.abs(maxH - minH) < 1e-6
      ? roundedMinH
      : Math.min(Math.ceil(maxH * 255), 255);
  return (roundedMinH << 8) + roundedMaxH;
}

// TODO Actually current structure is not fast when each leaf only have one primitive.
// But it accelerated a lot for the result of https://github.com/madmann91/bvh
// In which leaf may have multiple primitives.
export function flattenBvh(
  bvh: InteriorNode | undefined,
  isTLAS: boolean,
  trianglesDisplacement?: Float32Array
): FlattendBVH {
  const flat: number[] = [];
  const instancesArr: number[] | undefined = isTLAS ? [] : undefined;

  let buildSurfaceArea = 0;
  let maxDepth = 1;
  let maxLeafPrimitives = 1;
  let instanceCount = 0;
  const traverse = (node: InteriorNode | LeafNode, depth = 1) => {
    maxDepth = Math.max(depth, maxDepth);

    const bounds = node.bounds;
    if (!isTLAS) buildSurfaceArea += surfaceArea(bounds);
    const start = flat.length;

    flat.push(
      bounds.min[0],
      bounds.min[1],
      bounds.min[2],
      // Pointer to second child
      // Or num of primitives(negative)
      0,
      bounds.max[0],
      bounds.max[1],
      bounds.max[2],
      0
    );

    if ((node as LeafNode).primitives) {
      const primitivesLen = (node as LeafNode).primitives.length;
      maxLeafPrimitives = Math.max(maxLeafPrimitives, primitivesLen);
      // negative signals to shader that this node is a triangle
      flat[start + 3] = -primitivesLen;
      for (let i = 0; i < primitivesLen; i++) {
        const p = (node as LeafNode).primitives[i];
        if (isTLAS) {
          const tlas = p as TLASPrimitiveInfo;
          const mInv = mat4.create();
          const m = tlas.transform;
          mat4.invert(mInv, m);
          // Keep the source instance index in the otherwise-unused z lane so
          // the flattened TLAS can be refitted without rebuilding its topology.
          flat.push(instanceCount, tlas.primitive, tlas.sourceIndex, 0);
          const encodedBlasOffset = encodeBlasOffset(
            tlas.primitive,
            tlas.blasLayout
          );
          instancesArr!.push(
            encodedBlasOffset,
            tlas.vertexOffset,
            tlas.materialIndex,
            tlas.displacementScale || 0
          );
          for (let j = 0; j < 16; j++) {
            instancesArr!.push(mInv[j]);
          }
          for (let j = 0; j < 16; j++) {
            instancesArr!.push(m[j]);
          }
          instancesArr!.push(tlas.uvProjection, tlas.displacementUvProjection, 0, 0);
          instanceCount++;
        } else {
          const triangleIndex = p.primitive;
          const indices = (p as BLASPrimitiveInfo).indices;
          let minH = 0;
          let maxH = 0;
          if (trianglesDisplacement) {
            minH = trianglesDisplacement[triangleIndex * 2];
            maxH = trianglesDisplacement[triangleIndex * 2 + 1];
          }
          // Pack minH, maxH to one channel
          flat.push(indices[0], indices[1], indices[2], packH(minH, maxH));
        }
      }
    } else {
      traverse((node as InteriorNode).child0, depth + 1);
      flat[start + 3] = flat.length / 4; // pointer to second child
      traverse((node as InteriorNode).child1, depth + 1);
    }
  };

  bvh && traverse(bvh);

  const buffer = new ArrayBuffer(4 * flat.length);
  const floatView = new Float32Array(buffer);
  const intView = new Int32Array(buffer);

  for (let k = 0; k < flat.length; ) {
    const primCountOrSplitAxis = flat[k + 3];
    intView[k + 3] = primCountOrSplitAxis;
    // Bounds
    floatView[k] = flat[k];
    floatView[k + 1] = flat[k + 1];
    floatView[k + 2] = flat[k + 2];
    floatView[k + 4] = flat[k + 4] || 0;
    floatView[k + 5] = flat[k + 5] || 0;
    floatView[k + 6] = flat[k + 6] || 0;

    k += 8;

    if (primCountOrSplitAxis >= 0) {
      // Is internal node
      intView[k - 1] = flat[k - 1];
    } else {
      // Is leaf
      for (let i = 0; i < -primCountOrSplitAxis; i++) {
        for (let j = 0; j < 4; j++) {
          intView[k + j] = flat[k + j];
        }
        k += 4;
      }
    }
  }

  let instancesArrBuffer;
  if (instancesArr) {
    const instancesArrF32 = new Float32Array(instancesArr.length);
    instancesArrBuffer = instancesArrF32.buffer;
    const instancesArrI32 = new Int32Array(instancesArrBuffer);

    for (let i = 0; i < instancesArr.length; i += INSTANCE_WORD_STRIDE) {
      for (let k = 0; k < 3; k++) {
        instancesArrI32[i + k] = instancesArr[i + k];
      }
      instancesArrF32[i + 3] = instancesArr[i + 3];
      for (let k = 4; k < INSTANCE_WORD_STRIDE; k++) {
        instancesArrF32[i + k] = instancesArr[i + k];
      }
    }
  }
  return {
    builder: 'builtin',
    buildSurfaceArea: isTLAS ? undefined : buildSurfaceArea,
    maxDepth: bvh ? maxDepth : 0,
    maxLeafPrimitives: bvh ? maxLeafPrimitives : 0,
    buffer: floatView.buffer,
    layout: 'bvh2',
    instancesBuffer: instancesArrBuffer
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

  let blasOffset = 0;
  let vertexOffset = 0;
  const blasOffsets: number[] = [];
  const vertexOffsets: number[] = [];
  const layouts: BvhLayout[] = [];
  blases.forEach((blas) => {
    blasOffsets.push(blasOffset);
    vertexOffsets.push(vertexOffset);
    layouts.push(blas.bvh.layout ?? 'bvh2');
    blasOffset += blas.bvh.buffer.byteLength / 16;
    vertexOffset += blas.verticesCount;
  });

  function writeInstance(targetIndex: number, sourceIndex: number) {
    const instance = instances[sourceIndex];
    const offset = targetIndex * INSTANCE_WORD_STRIDE;
    const encodedBlasOffset = encodeBlasOffset(
      blasOffsets[instance.blasIndex],
      layouts[instance.blasIndex]
    );
    instanceInts[offset] = encodedBlasOffset;
    instanceInts[offset + 1] = vertexOffsets[instance.blasIndex];
    instanceInts[offset + 2] = instance.materialsIndices[0] || 0;
    instanceFloats[offset + 3] = instance.displacementScale || 0;
    instanceFloats[offset + 36] = instance.uvProjection ?? -1;
    instanceFloats[offset + 37] = instance.displacementUvProjection ?? -1;
    const inverse = mat4.invert(mat4.create(), instance.transform);
    for (let i = 0; i < 16; i++) {
      instanceFloats[offset + 4 + i] = inverse[i];
      instanceFloats[offset + 20 + i] = instance.transform[i];
    }
  }

  function addInstanceBounds(bounds: Box3, instance: TLASInstance) {
    const min = vec3.clone(instance.bounds.min);
    const max = vec3.clone(instance.bounds.max);
    if (instance.displacementScale) {
      const transform = instance.transform;
      const scaleX = vec3.length(
        vec3.fromValues(transform[0], transform[1], transform[2])
      );
      const scaleY = vec3.length(
        vec3.fromValues(transform[4], transform[5], transform[6])
      );
      const scaleZ = vec3.length(
        vec3.fromValues(transform[8], transform[9], transform[10])
      );
      const pad = vec3.fromValues(
        Math.max(0, instance.displacementScale * scaleX),
        Math.max(0, instance.displacementScale * scaleY),
        Math.max(0, instance.displacementScale * scaleZ)
      );
      vec3.sub(min, min, pad);
      vec3.add(max, max, pad);
    }
    vec3Min(bounds.min, bounds.min, min);
    vec3Max(bounds.max, bounds.max, max);
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

/** Refit a legacy BVH2 BLAS after vertex deformation, preserving topology. */
export function refitBLAS(
  flattened: FlattendBVH,
  geometry: Pick<Geometry, 'position'> & Partial<Pick<Geometry, 'dynamic'>>
) {
  if ((flattened.layout ?? 'bvh2') !== 'bvh2' || !flattened.buffer.byteLength) {
    return false;
  }
  const floats = new Float32Array(flattened.buffer);
  const ints = new Int32Array(flattened.buffer);
  const positions = geometry.position.array;
  let beforeArea = 0, afterArea = 0;

  function addVertex(bounds: Box3, vertexIndex: number) {
    const offset = vertexIndex * geometry.position.itemSize;
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    bounds.min[0] = Math.min(bounds.min[0], x);
    bounds.min[1] = Math.min(bounds.min[1], y);
    bounds.min[2] = Math.min(bounds.min[2], z);
    bounds.max[0] = Math.max(bounds.max[0], x);
    bounds.max[1] = Math.max(bounds.max[1], y);
    bounds.max[2] = Math.max(bounds.max[2], z);
  }

  function refitNode(index: number): Box3 {
    const base = index * 4;
    const bounds = new Box3();
    const dx = floats[base + 4] - floats[base], dy = floats[base + 5] - floats[base + 1], dz = floats[base + 6] - floats[base + 2];
    beforeArea += 2 * (dx * dz + dx * dy + dz * dy);
    const primitiveCountOrChild = ints[base + 3];
    if (primitiveCountOrChild >= 0) {
      unionBounds(
        bounds,
        refitNode(index + 2),
        refitNode(primitiveCountOrChild)
      );
    } else {
      for (let i = 0; i < -primitiveCountOrChild; i++) {
        const triangleOffset = base + 8 + i * 4;
        addVertex(bounds, ints[triangleOffset]);
        addVertex(bounds, ints[triangleOffset + 1]);
        addVertex(bounds, ints[triangleOffset + 2]);
      }
    }
    afterArea += surfaceArea(bounds);
    floats[base] = bounds.min[0];
    floats[base + 1] = bounds.min[1];
    floats[base + 2] = bounds.min[2];
    floats[base + 4] = bounds.max[0];
    floats[base + 5] = bounds.max[1];
    floats[base + 6] = bounds.max[2];
    return bounds;
  }

  refitNode(0);
  flattened.buildSurfaceArea ??= beforeArea;
  return !geometry.dynamic || !(afterArea > flattened.buildSurfaceArea * DYNAMIC_BLAS_REBUILD_RATIO);
}

function makeBLASPrimitiveInfo(
  geometry: Pick<Geometry, 'position' | 'indices' | 'normal'>,
  displacementScale: number,
  // Displacement scale for each triangle
  trianglesDisplacement?: Float32Array
): BLASPrimitiveInfo[] {
  const primitiveInfo = [];
  const indices = geometry.indices?.array;
  const position = geometry.position;

  const normal = geometry.normal;
  // const materialMeshIndex = geometry.materialMeshIndex;
  // const hasMaterialMeshIndex = materialMeshIndex != null;

  const v0 = vec3.create();
  const v1 = vec3.create();
  const v2 = vec3.create();
  const v3 = vec3.create();
  const v4 = vec3.create();
  const v5 = vec3.create();

  const e0 = vec3.create();
  const e1 = vec3.create();

  const n0 = vec3.create();
  const n1 = vec3.create();
  const n2 = vec3.create();

  const usePrism = trianglesDisplacement != null && normal != null;

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];

    const bounds = new Box3();
    const min = bounds.min;
    const max = bounds.max;

    Attribute.getItem(position, v0, i0);
    Attribute.getItem(position, v1, i1);
    Attribute.getItem(position, v2, i2);

    vec3Sub(e0, v2, v0);
    vec3Sub(e1, v1, v0);

    if (usePrism) {
      Attribute.getItem(normal, n0, i0);
      Attribute.getItem(normal, n1, i1);
      Attribute.getItem(normal, n2, i2);

      let minHeight = trianglesDisplacement[(i / 3) * 2] * displacementScale;
      let maxHeight =
        trianglesDisplacement[(i / 3) * 2 + 1] * displacementScale;

      if (isNaN(minHeight) || isNaN(maxHeight)) {
        minHeight = 0;
        maxHeight = displacementScale;
      }

      // let minHeight = 0;
      // let maxHeight = displacementScale;

      vec3.normalize(n0, n0);
      vec3.normalize(n1, n1);
      vec3.normalize(n2, n2);

      vec3.scaleAndAdd(v3, v0, n0, maxHeight);
      vec3.scaleAndAdd(v4, v1, n1, maxHeight);
      vec3.scaleAndAdd(v5, v2, n2, maxHeight);

      vec3.scaleAndAdd(v0, v0, n0, minHeight);
      vec3.scaleAndAdd(v1, v1, n1, minHeight);
      vec3.scaleAndAdd(v2, v2, n2, minHeight);

      vec3Min(min, min, v0);
      vec3Min(min, min, v1);
      vec3Min(min, min, v2);
      vec3Min(min, min, v3);
      vec3Min(min, min, v4);
      vec3Min(min, min, v5);

      vec3Max(max, max, v0);
      vec3Max(max, max, v1);
      vec3Max(max, max, v2);
      vec3Max(max, max, v3);
      vec3Max(max, max, v4);
      vec3Max(max, max, v5);
    } else {
      vec3Min(min, min, v0);
      vec3Min(min, min, v1);
      vec3Min(min, min, v2);
      vec3Max(max, max, v0);
      vec3Max(max, max, v1);
      vec3Max(max, max, v2);
    }

    const center = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2
    ] as vec3.Vec3Array;
    const info: BLASPrimitiveInfo = {
      bounds,
      center,
      primitive: i / 3,
      indices: [i0, i1, i2]
    };

    if (!isNaN(center[0]) && !isNaN(center[1]) && !isNaN(center[2])) {
      primitiveInfo.push(info);
    }
  }

  return primitiveInfo;
}

export function recursiveBuild(
  primitiveInfo: (BLASPrimitiveInfo | TLASPrimitiveInfo)[],
  start: number,
  end: number
): LeafNode | InteriorNode {
  const bounds = new Box3();
  for (let i = start; i < end; i++) {
    unionBounds(bounds, bounds, primitiveInfo[i].bounds);
  }

  const nPrimitives = end - start;

  if (nPrimitives === 1) {
    return makeLeafNode(primitiveInfo.slice(start, end), bounds);
  } else {
    const centroidBounds = new Box3();
    for (let i = start; i < end; i++) {
      vec3Min(centroidBounds.min, centroidBounds.min, primitiveInfo[i].center);
      vec3Max(centroidBounds.max, centroidBounds.max, primitiveInfo[i].center);
    }
    const dim = maximumExtent(centroidBounds);

    let mid = Math.floor((start + end) / 2);

    // middle split method
    // const dimMid = (centroidBounds.max[dim] + centroidBounds.min[dim]) / 2;
    // mid = partition(primitiveInfo, p => p.center[dim] < dimMid, start, end);

    // if (mid === start || mid === end) {
    //   mid = Math.floor((start + end) / 2);
    //   nthElement(primitiveInfo, (a, b) => a.center[dim] < b.center[dim], start, end, mid);
    // }

    // surface area heuristic method
    if (nPrimitives <= 4) {
      nthElement(
        primitiveInfo,
        (a, b) => a.center[dim] < b.center[dim],
        start,
        end,
        mid
      );
    } else if (centroidBounds.max[dim] === centroidBounds.min[dim]) {
      // can't split primitives based on centroid bounds. terminate.
      return makeLeafNode(primitiveInfo.slice(start, end), bounds);
    } else {
      const buckets = [];
      for (let i = 0; i < 12; i++) {
        buckets.push({
          bounds: new Box3(),
          count: 0
        });
      }

      for (let i = start; i < end; i++) {
        let b = Math.floor(
          buckets.length *
            boxOffset(centroidBounds, dim, primitiveInfo[i].center)
        );
        if (b === buckets.length) {
          b = buckets.length - 1;
        }
        buckets[b].count++;

        unionBounds(
          buckets[b].bounds,
          buckets[b].bounds,
          primitiveInfo[i].bounds
        );
      }

      const cost = [];

      for (let i = 0; i < buckets.length - 1; i++) {
        const b0 = new Box3();
        const b1 = new Box3();
        let count0 = 0;
        let count1 = 0;
        for (let j = 0; j <= i; j++) {
          unionBounds(b0, b0, buckets[j].bounds);
          count0 += buckets[j].count;
        }
        for (let j = i + 1; j < buckets.length; j++) {
          unionBounds(b1, b1, buckets[j].bounds);
          count1 += buckets[j].count;
        }
        cost.push(
          0.1 +
            (count0 * surfaceArea(b0) + count1 * surfaceArea(b1)) /
              surfaceArea(bounds)
        );
      }

      let minCost = cost[0];
      let minCostSplitBucket = 0;
      for (let i = 1; i < cost.length; i++) {
        if (cost[i] < minCost) {
          minCost = cost[i];
          minCostSplitBucket = i;
        }
      }

      mid = partition(
        primitiveInfo,
        (p) => {
          let b = Math.floor(
            buckets.length * boxOffset(centroidBounds, dim, p.center)
          );
          if (b === buckets.length) {
            b = buckets.length - 1;
          }
          return b <= minCostSplitBucket;
        },
        start,
        end
      );
    }

    return makeInteriorNode(
      dim,
      recursiveBuild(primitiveInfo, start, mid),
      recursiveBuild(primitiveInfo, mid, end)
    );
  }
}

function makeLeafNode(
  primitives: (BLASPrimitiveInfo | TLASPrimitiveInfo)[],
  bounds: Box3
): LeafNode {
  return {
    primitives,
    bounds
  };
}

function makeInteriorNode(
  splitAxis: 0 | 1 | 2,
  child0: InteriorNode | LeafNode,
  child1: InteriorNode | LeafNode
): InteriorNode {
  return {
    child0,
    child1,
    bounds: unionBounds(new Box3(), child0.bounds, child1.bounds),
    splitAxis
  };
}
const size: vec3.Vec3Array = [0, 0, 0];

function maximumExtent(box3: Box3) {
  vec3Sub(size, box3.max, box3.min);
  if (size[0] > size[2]) {
    return size[0] > size[1] ? 0 : 1;
  } else {
    return size[2] > size[1] ? 2 : 1;
  }
}

function boxOffset(box3: Box3, dim: number, v: vec3.Vec3Array) {
  let offset = v[dim] - box3.min[dim];

  if (box3.max[dim] > box3.min[dim]) {
    offset /= box3.max[dim] - box3.min[dim];
  }

  return offset;
}

function surfaceArea(box3: Box3) {
  vec3Sub(size, box3.max, box3.min);
  return 2 * (size[0] * size[2] + size[0] * size[1] + size[2] * size[1]);
}
