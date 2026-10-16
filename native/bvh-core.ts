import { buildBinnedSahBvh, layoutBvh2 } from '../src/renderer/binnedSahBvh.js';

/** Entire SAH builder + traversal layout, transported as little-endian words.
 * Input: packed minXYZ/maxXYZ f32 boxes. Output header (8 u32 words):
 * version, nodeCount, primitiveCount, vec4Count, maxDepth, maxLeafPrimitives, 0, 0.
 * Payload: bounds, leftFirst, primCount, primIndices, order, offsets.
 */
export function buildBvh(bytes: Uint8Array): Uint8Array {
  const count = bytes.byteLength / 24;
  const bvh = buildBinnedSahBvh(new Float32Array(bytes.buffer, bytes.byteOffset, count * 6), count);
  const layout = layoutBvh2(bvh);
  const result = new ArrayBuffer((8 + bvh.nodeCount * 10 + count) * 4);
  const words = new Uint32Array(result);
  words.set([1, bvh.nodeCount, count, layout.vec4Count, layout.maxDepth, layout.maxLeafPrimitives, 0, 0]);
  let offset = 8;
  const bounds = new Uint32Array(bvh.bounds.buffer);
  for (let i = 0; i < bvh.nodeCount * 6; i++) words[offset++] = bounds[i];
  for (let i = 0; i < bvh.nodeCount; i++) words[offset++] = bvh.leftFirst[i];
  for (let i = 0; i < bvh.nodeCount; i++) words[offset++] = bvh.primCount[i];
  for (let i = 0; i < count; i++) words[offset++] = bvh.primIndices[i];
  for (let i = 0; i < bvh.nodeCount; i++) words[offset++] = layout.order[i];
  for (let i = 0; i < bvh.nodeCount; i++) words[offset++] = layout.offsets[i];
  return new Uint8Array(result);
}
