import {
  MAX_TRAVERSAL_STACK_SIZE,
  type FlattendBVH
} from '../renderer/bvhAccel.js';
import type Geometry from '../scene/Geometry.js';
import { VERSION } from '../version.js';

const wasmUrl = new URL('./tinybvh.wasm', import.meta.url);

export type TinyBvhLayout = 'bvh2' | 'bvh4' | 'bvh-gpu' | 'cwbvh';

const tinyBvhLayoutCodes: Record<TinyBvhLayout, number> = {
  bvh2: 0,
  bvh4: 1,
  'bvh-gpu': 2,
  cwbvh: 3
};
const tinyBvhLayouts: TinyBvhLayout[] = [
  'bvh2',
  'bvh4',
  'bvh-gpu',
  'cwbvh'
];

interface TinyBvhExports extends WebAssembly.Exports {
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
}

let warnedWasmFallback = false;

async function fetchTinyBvhWasm(url: URL | string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load TinyBVH WASM from ${url} (${response.status})`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error(`Invalid TinyBVH WASM from ${url}: expected \"\\0asm\" signature (received non-WASM content).`);
  }
  return buffer;
}

let exportsPromise: Promise<TinyBvhExports> | undefined;
let wasmModulePromise: Promise<WebAssembly.Module> | undefined;
let buildQueue: Promise<void> = Promise.resolve();

export interface TinyBvhBuildResult extends FlattendBVH {
  builder: 'tinybvh';
  bvhTimeMs: number;
}

async function instantiateTinyBvh() {
  const imports = {
    env: {
      emscripten_notify_memory_growth: () => undefined
    },
    wasi_snapshot_preview1: {
      proc_exit: (code: number) => {
        throw new Error(`tinybvh exited with status ${code}`);
      },
      fd_close: () => 0,
      fd_write: () => 0,
      fd_seek: () => 0
    }
  };
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      let buffer: ArrayBuffer;
      try {
        buffer = await fetchTinyBvhWasm(wasmUrl);
      } catch (error) {
        if (!warnedWasmFallback) {
          warnedWasmFallback = true;
          console.warn('Bundled TinyBVH WASM failed to load; falling back to jsDelivr. In Vite development add optimizeDeps: { exclude: ["@meimu/mutracer"] }. For OIDN assets you can also pass weightsBaseUrl.', error);
        }
        buffer = await fetchTinyBvhWasm(`https://cdn.jsdelivr.net/npm/@meimu/mutracer@${VERSION}/lib/tinybvh/tinybvh.wasm`);
      }
      return WebAssembly.compile(buffer);
    })();
  }
  const instance = await WebAssembly.instantiate(
    await wasmModulePromise,
    imports
  );
  const tinyBvh = instance.exports as TinyBvhExports;
  tinyBvh._initialize();
  return tinyBvh;
}

/**
 * Computes the exact stack used by TinyBVH's official CWBVH node-group
 * traversal. A group containing all remaining interior siblings occupies one
 * entry, so the generic wide-BVH child-address stack requirement is far too
 * conservative for this layout.
 */
export function getCwbvhTraversalStackSize(buffer: ArrayBuffer) {
  const words = new Uint32Array(buffer);
  const active = new Set<number>();
  const memo = new Map<number, number>();
  const visit = (nodeIndex: number): number => {
    const cached = memo.get(nodeIndex);
    if (cached != null) return cached;
    const nodeOffset = nodeIndex * 20;
    if (nodeOffset < 0 || nodeOffset + 20 > words.length) {
      throw new Error(`CWBVH node ${nodeIndex} is outside the serialized buffer`);
    }
    if (active.has(nodeIndex)) {
      throw new Error(`CWBVH node ${nodeIndex} forms a cycle`);
    }
    active.add(nodeIndex);
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
    active.delete(nodeIndex);
    const requirement = (interiorChildren > 1 ? 1 : 0) + childRequirement;
    memo.set(nodeIndex, requirement);
    return requirement;
  };
  return Math.max(1, visit(0));
}

async function loadTinyBvh() {
  if (!exportsPromise) {
    exportsPromise = instantiateTinyBvh();
  }
  return exportsPromise;
}

export async function initializeTinyBvh() {
  await loadTinyBvh();
}

function allocateAndCopy(
  tinyBvh: TinyBvhExports,
  values: ArrayBufferView | undefined
) {
  if (!values?.byteLength) return 0;
  const pointer = tinyBvh.malloc(values.byteLength);
  if (!pointer) throw new Error('tinybvh could not allocate WASM memory');
  new Uint8Array(tinyBvh.memory.buffer, pointer, values.byteLength).set(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
  );
  return pointer;
}

/**
 * Builds a renderer-compatible BLAS with TinyBVH's binned SAH builder, or
 * with spatial splits (SBVH) when requested.
 */
async function buildTinyBvhUnlocked(
  geometry: Geometry,
  displacementScale: number,
  trianglesDisplacement?: Float32Array,
  requestedLayout: TinyBvhLayout = 'bvh2',
  spatialSplits = false
): Promise<TinyBvhBuildResult> {
  // CWBVH conversion is recursive and experimental. Isolate each static
  // conversion so a trap in one pathological mesh cannot poison the allocator
  // used by every later BLAS in this worker.
  const isolated = requestedLayout === 'cwbvh';
  const tinyBvh = isolated ? await instantiateTinyBvh() : await loadTinyBvh();
  const positions = geometry.position.array;
  const normals = geometry.normal?.array;
  const indices =
    geometry.indices.array instanceof Uint32Array
      ? geometry.indices.array
      : Uint32Array.from(geometry.indices.array);
  const pointers: number[] = [];
  let result = 0;
  let poisoned = false;
  const buildStart = performance.now();

  try {
    const positionsPointer = allocateAndCopy(tinyBvh, positions);
    pointers.push(positionsPointer);
    const normalsPointer = allocateAndCopy(tinyBvh, normals);
    if (normalsPointer) pointers.push(normalsPointer);
    const indicesPointer = allocateAndCopy(tinyBvh, indices);
    pointers.push(indicesPointer);
    const displacementPointer = allocateAndCopy(tinyBvh, trianglesDisplacement);
    if (displacementPointer) pointers.push(displacementPointer);
    result = tinyBvh.tinybvh_build(
      positionsPointer,
      positions.length / geometry.position.itemSize,
      geometry.position.itemSize,
      normalsPointer,
      geometry.normal?.itemSize ?? 0,
      indicesPointer,
      indices.length,
      displacementScale,
      displacementPointer,
      tinyBvhLayoutCodes[requestedLayout],
      spatialSplits ? 1 : 0
    );
    if (!result) throw new Error('tinybvh did not return a build result');

    const byteLength = tinyBvh.tinybvh_result_size(result);
    if (!byteLength) throw new Error('tinybvh generated an empty BVH');
    const reportedMaxDepth = tinyBvh.tinybvh_result_max_depth(result);
    const dataPointer = tinyBvh.tinybvh_result_data(result);
    const layoutCode = tinyBvh.tinybvh_result_layout(result);
    const layout = tinyBvhLayouts[layoutCode];
    if (!layout) throw new Error(`tinybvh returned unknown layout ${layoutCode}`);
    const buffer = byteLength
      ? tinyBvh.memory.buffer.slice(dataPointer, dataPointer + byteLength)
      : new ArrayBuffer(0);
    const maxDepth = layout === 'cwbvh'
      ? getCwbvhTraversalStackSize(buffer)
      : reportedMaxDepth;
    if (maxDepth > MAX_TRAVERSAL_STACK_SIZE) {
      throw new Error(
        'tinybvh traversal requires more stack entries than available ' +
          `(${maxDepth} > ${MAX_TRAVERSAL_STACK_SIZE})`
      );
    }
    return {
      builder: 'tinybvh',
      buffer,
      maxDepth,
      layout,
      bvhTimeMs: performance.now() - buildStart
    };
  } catch (error) {
    // A TinyBVH stack overflow or out-of-bounds trap can leave emmalloc's
    // state unusable. Do not let one pathological mesh turn every later BLAS
    // in the scene into a built-in-builder fallback.
    if (
      error instanceof WebAssembly.RuntimeError ||
      error instanceof RangeError
    ) {
      poisoned = true;
      if (!isolated) {
        exportsPromise = undefined;
      }
    }
    throw error;
  } finally {
    if (!poisoned) {
      if (result) tinyBvh.tinybvh_result_destroy(result);
      pointers.forEach((pointer) => tinyBvh.free(pointer));
    }
  }
}

export function buildTinyBvh(
  geometry: Geometry,
  displacementScale: number,
  trianglesDisplacement?: Float32Array,
  requestedLayout: TinyBvhLayout = 'bvh2',
  spatialSplits = false
): Promise<TinyBvhBuildResult> {
  const task = buildQueue.then(() => buildTinyBvhUnlocked(
    geometry,
    displacementScale,
    trianglesDisplacement,
    requestedLayout,
    spatialSplits
  ));
  buildQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}
