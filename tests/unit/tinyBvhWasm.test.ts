import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import { MAX_TRAVERSAL_STACK_SIZE } from '../../src/renderer/bvhAccel';
import {
  buildTinyBvh,
  getCwbvhTraversalStackSize
} from '../../src/tinybvh/TinyBvhBuilder';

type TinyBvhExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(pointer: number): void;
  tinybvh_build(
    positions: number,
    vertexCount: number,
    positionStride: number,
    normals: number,
    normalStride: number,
    indices: number,
    indexCount: number,
    displacementScale: number,
    displacement: number,
    requestedLayout: number,
    spatialSplits: number
  ): number;
  tinybvh_result_data(result: number): number;
  tinybvh_result_size(result: number): number;
  tinybvh_result_max_depth(result: number): number;
  tinybvh_result_layout(result: number): number;
  tinybvh_result_destroy(result: number): void;
  _initialize(): void;
};

let tinyBvh: TinyBvhExports;
let wasmBytes: Uint8Array;

function allocate(values: ArrayBufferView) {
  const pointer = tinyBvh.malloc(values.byteLength);
  new Uint8Array(tinyBvh.memory.buffer, pointer, values.byteLength).set(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
  );
  return pointer;
}

function build(
  positions: Float32Array,
  indices: Uint32Array,
  normals?: Float32Array,
  displacement?: Float32Array,
  requestedLayout = 1,
  spatialSplits = false
) {
  const pointers = [allocate(positions), allocate(indices)];
  const normalPointer = normals ? allocate(normals) : 0;
  const displacementPointer = displacement ? allocate(displacement) : 0;
  if (normalPointer) pointers.push(normalPointer);
  if (displacementPointer) pointers.push(displacementPointer);
  const result = tinyBvh.tinybvh_build(
    pointers[0],
    positions.length / 4,
    4,
    normalPointer,
    normals ? 4 : 0,
    pointers[1],
    indices.length,
    displacement ? 2 : 0,
    displacementPointer,
    requestedLayout,
    +spatialSplits
  );
  const size = tinyBvh.tinybvh_result_size(result);
  const data = tinyBvh.tinybvh_result_data(result);
  const buffer = tinyBvh.memory.buffer.slice(data, data + size);
  const layout = tinyBvh.tinybvh_result_layout(result);
  const stackRequirement = tinyBvh.tinybvh_result_max_depth(result);
  tinyBvh.tinybvh_result_destroy(result);
  pointers.forEach((pointer) => tinyBvh.free(pointer));
  return { buffer, layout, stackRequirement };
}

function collectCwbvhTriangles(buffer: ArrayBuffer) {
  const words = new Uint32Array(buffer);
  const nodeStack = [0];
  const visitedNodes = new Set<number>();
  const triangles: string[] = [];
  while (nodeStack.length) {
    const nodeIndex = nodeStack.pop()!;
    if (visitedNodes.has(nodeIndex)) {
      throw new Error(`CWBVH node ${nodeIndex} was referenced more than once`);
    }
    visitedNodes.add(nodeIndex);
    const nodeOffset = nodeIndex * 20;
    const childBase = words[nodeOffset + 4];
    const triangleBase = words[nodeOffset + 5];
    const internalMask = words[nodeOffset + 3] >>> 24;
    for (let slot = 0; slot < 8; slot++) {
      const childMeta =
        (words[nodeOffset + 6 + (slot >>> 2)] >>> ((slot & 3) * 8)) & 0xff;
      if (!childMeta) continue;
      const localOffset = childMeta & 0x1f;
      if (localOffset >= 24) {
        if ((internalMask & (1 << slot)) === 0) {
          throw new Error(`CWBVH node ${nodeIndex} has an invalid interior slot`);
        }
        const precedingMask = internalMask & ((1 << slot) - 1);
        let relativeIndex = 0;
        for (let bits = precedingMask; bits; bits &= bits - 1) relativeIndex++;
        nodeStack.push(childBase + relativeIndex);
        continue;
      }
      if ((internalMask & (1 << slot)) !== 0) {
        throw new Error(`CWBVH node ${nodeIndex} has an invalid triangle slot`);
      }
      const triangleCount = ((childMeta >>> 5) & 1)
        + ((childMeta >>> 6) & 1)
        + ((childMeta >>> 7) & 1);
      if (localOffset + triangleCount > 24) {
        throw new Error(`CWBVH node ${nodeIndex} exceeds its triangle mask`);
      }
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        const wordOffset = (triangleBase + localOffset + triangle) * 4;
        triangles.push(Array.from(words.slice(wordOffset, wordOffset + 3)).join(','));
      }
    }
  }
  return triangles;
}

function getCwbvhGroupStackRequirement(buffer: ArrayBuffer) {
  const words = new Uint32Array(buffer);
  const visit = (nodeIndex: number): number => {
    const nodeOffset = nodeIndex * 20;
    const childBase = words[nodeOffset + 4];
    const internalMask = words[nodeOffset + 3] >>> 24;
    let relativeIndex = 0;
    let interiorChildren = 0;
    let childRequirement = 0;
    for (let slot = 0; slot < 8; slot++) {
      if ((internalMask & (1 << slot)) === 0) continue;
      interiorChildren++;
      childRequirement = Math.max(
        childRequirement,
        visit(childBase + relativeIndex)
      );
      relativeIndex++;
    }
    return (interiorChildren > 1 ? 1 : 0) + childRequirement;
  };
  return Math.max(1, visit(0));
}

beforeAll(async () => {
  wasmBytes = await readFile(
    new URL('../../src/tinybvh/tinybvh.wasm', import.meta.url)
  );
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: { emscripten_notify_memory_growth: () => undefined },
    wasi_snapshot_preview1: {
      proc_exit: (code: number) => {
        throw new Error(`tinybvh exited with status ${code}`);
      },
      fd_close: () => 0,
      fd_write: () => 0,
      fd_seek: () => 0
    }
  });
  tinyBvh = instance.exports as TinyBvhExports;
  tinyBvh._initialize();
});

/** SAH cost of a BVH2 buffer (C_TRAV = C_INT = 1), relative to the root. */
function sahCost(buffer: ArrayBuffer) {
  const floats = new Float32Array(buffer), ints = new Int32Array(buffer);
  const area = (i: number) => {
    const b = i * 4, x = floats[b + 4] - floats[b], y = floats[b + 5] - floats[b + 1], z = floats[b + 6] - floats[b + 2];
    return x * y + y * z + z * x;
  };
  let cost = 0;
  const stack = [0];
  while (stack.length) {
    const i = stack.pop()!, child = ints[i * 4 + 3];
    if (child >= 0) { cost += area(i); stack.push(i + 2, child); } else cost += -child * area(i);
  }
  return cost / area(0);
}

describe('tinybvh WASM builders', () => {
  // A sphere with long, thin triangles near the poles, where spatial splits apply.
  async function sphere() {
    const { createSphereGeometry } = await import('../../src/util/commonGeometry');
    const geometry = createSphereGeometry(48, 24);
    const source = geometry.position.array;
    const positions = new Float32Array((source.length / 3) * 4);
    for (let i = 0; i < source.length / 3; i++) positions.set(source.subarray(i * 3, i * 3 + 3), i * 4);
    return { geometry, positions, indices: Uint32Array.from(geometry.indices.array) };
  }

  it('builds with binned SAH unless spatial splits are requested', async () => {
    const { geometry, positions, indices } = await sphere();
    const { buildBLAS } = await import('../../src/renderer/bvhAccel');
    const binned = build(positions, indices, undefined, undefined, 0);
    // The JavaScript port matches TinyBVH's binned builder in quality; float64
    // costs may resolve near-ties differently, so trees need not be identical.
    const ported = buildBLAS(geometry);
    expect(Math.abs(sahCost(ported.buffer) / sahCost(binned.buffer) - 1)).toBeLessThan(0.01);
    expect(Math.abs(ported.buffer.byteLength - binned.buffer.byteLength)).toBeLessThan(binned.buffer.byteLength * 0.01);

    // Long thin triangles crossing the scene in all directions overlap
    // everywhere, which spatial splits resolve.
    let seed = 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const slivers = new Float32Array(64 * 3 * 4);
    for (let i = 0; i < 64; i++) {
      const a = [random(), random(), random()], b = [random(), random(), random()];
      slivers.set([...a, 0, ...b, 0, b[0] + 0.01, b[1], b[2], 0], i * 12);
    }
    const sliverIndices = Uint32Array.from({ length: 64 * 3 }, (_, i) => i);
    const sliversBinned = build(slivers, sliverIndices, undefined, undefined, 0);
    const sliversSbvh = build(slivers, sliverIndices, undefined, undefined, 0, true);
    expect(sliversSbvh.buffer.byteLength).toBeGreaterThan(sliversBinned.buffer.byteLength);
  });
});

describe('tinybvh WASM layouts', () => {
  const positions = new Float32Array([
    0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  it('exposes renderer-compatible TinyBVH metadata', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(wasmBytes) as Response;
    try {
      const geometry = new Geometry({
        position: new Attribute(positions, 4),
        normal: new Attribute(
          new Float32Array([
            0, 0, 1, 0,
            0, 0, 1, 0,
            0, 0, 1, 0,
            0, 0, 1, 0
          ]),
          4
        ),
        indices: new Attribute(indices, 1)
      });
      const bvh = await buildTinyBvh(geometry, 0, undefined, 'bvh4');

      expect(bvh.builder).toBe('tinybvh');
      expect(bvh.layout).toBe('bvh4');
      expect(bvh.buffer.byteLength).toBeGreaterThan(64);
      expect(bvh.maxDepth).toBeLessThanOrEqual(MAX_TRAVERSAL_STACK_SIZE);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits indexed, quantized BVH4 data for regular triangles', () => {
    const { buffer, layout, stackRequirement } = build(positions, indices);
    const words = new Uint32Array(buffer);
    const floats = new Float32Array(buffer);
    const leafInfos = Array.from(words.slice(6, 10)).filter(
      (value) => (value & 0x80000000) !== 0
    );

    expect(layout).toBe(1);
    expect(stackRequirement).toBeLessThanOrEqual(MAX_TRAVERSAL_STACK_SIZE);
    expect(buffer.byteLength).toBeGreaterThan(64);
    expect(floats[3]).toBeGreaterThan(0);
    expect(floats[4]).toBeGreaterThan(0);
    expect(floats[5]).toBeGreaterThan(0);
    expect(leafInfos.length).toBeGreaterThan(0);

    const serializedTriangles = leafInfos.flatMap((info) => {
      const count = (info >>> 23) & 0xff;
      const offset = info & 0x007fffff;
      return Array.from({ length: count }, (_, triangle) => {
        const wordOffset = (offset + triangle) * 4;
        return Array.from(words.slice(wordOffset, wordOffset + 3)).join(',');
      });
    });
    expect(serializedTriangles).toEqual(
      expect.arrayContaining(['0,1,2', '0,2,3'])
    );
  });

  it('keeps displacement bounds in the legacy BVH2 layout', () => {
    const normals = new Float32Array([
      0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0
    ]);
    const displacement = new Float32Array([0, 1, 0.25, 0.75]);

    const { buffer, layout } = build(positions, indices, normals, displacement);

    expect(layout).toBe(0);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  it('can emit the legacy BVH2 layout for traversal benchmarks', () => {
    const { buffer, layout } = build(
      positions,
      indices,
      undefined,
      undefined,
      0
    );

    expect(layout).toBe(0);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  it('emits TinyBVH native BVH_GPU nodes with indexed triangle leaves', () => {
    const { buffer, layout } = build(
      positions,
      indices,
      undefined,
      undefined,
      2
    );
    const words = new Uint32Array(buffer);

    expect(layout).toBe(2);
    expect(words[11]).toBe(2);
    expect(words[15]).toBe(4);
    expect(Array.from(words.slice(16, 19)).join(',')).toBe('0,1,2');
  });

  it('encodes single-node meshes directly as CWBVH', () => {
    const { buffer, layout, stackRequirement } = build(
      positions,
      indices,
      undefined,
      undefined,
      3
    );
    const words = new Uint32Array(buffer);

    expect(layout).toBe(3);
    expect(buffer.byteLength).toBe(112);
    expect(words[5]).toBe(5);
    expect(words[6] & 0xff).toBe(0x60);
    expect(stackRequirement).toBe(1);
    expect(Array.from(words.slice(20, 23)).join(',')).toBe('0,1,2');
  });

  it('serializes multi-node CWBVH before consuming the source MBVH', () => {
    const triangleCount = 32;
    const gridPositions = new Float32Array(triangleCount * 3 * 4);
    const gridIndices = new Uint32Array(triangleCount * 3);
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const x = triangle % 8;
      const y = Math.floor(triangle / 8);
      for (let vertex = 0; vertex < 3; vertex++) {
        const index = triangle * 3 + vertex;
        gridPositions[index * 4] = x + (vertex === 1 ? 0.8 : 0);
        gridPositions[index * 4 + 1] = y + (vertex === 2 ? 0.8 : 0);
        gridPositions[index * 4 + 2] = (triangle % 3) * 0.01;
        gridIndices[index] = index;
      }
    }

    const { buffer, layout, stackRequirement } = build(
      gridPositions,
      gridIndices,
      undefined,
      undefined,
      3
    );

    expect(layout).toBe(3);
    expect(buffer.byteLength).toBeGreaterThan(triangleCount * 16);
    expect(stackRequirement).toBeLessThanOrEqual(MAX_TRAVERSAL_STACK_SIZE);
    expect(getCwbvhTraversalStackSize(buffer)).toBe(
      getCwbvhGroupStackRequirement(buffer)
    );
    expect(getCwbvhTraversalStackSize(buffer)).toBeLessThanOrEqual(
      stackRequirement
    );
    expect(collectCwbvhTriangles(buffer).sort()).toEqual(
      Array.from({ length: triangleCount }, (_, triangle) =>
        `${triangle * 3},${triangle * 3 + 1},${triangle * 3 + 2}`
      ).sort()
    );
  });

  it('splits large spatial leaves to fit the CWBVH triangle mask', () => {
    const triangleCount = 128;
    const overlappingPositions = new Float32Array(triangleCount * 3 * 4);
    const overlappingIndices = new Uint32Array(triangleCount * 3);
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const x = (triangle % 16) * 0.125;
      const y = Math.floor(triangle / 16) * 0.125;
      const vertices = [
        [x - 2, y, 0],
        [x + 2, y, 0],
        [x, y + 0.1, (triangle % 3) * 0.001]
      ];
      for (let vertex = 0; vertex < 3; vertex++) {
        const index = triangle * 3 + vertex;
        overlappingPositions.set(vertices[vertex], index * 4);
        overlappingIndices[index] = index;
      }
    }

    const { buffer, layout } = build(
      overlappingPositions,
      overlappingIndices,
      undefined,
      undefined,
      3
    );

    expect(layout).toBe(3);
    expect(new Set(collectCwbvhTriangles(buffer)).size).toBe(triangleCount);
  });
});
