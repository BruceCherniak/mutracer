import Geometry from '../scene/Geometry.js';

const warnedAttributes = new WeakSet<Int32Array>();

/** Resolves the public per-vertex raw material index, falling back to material 0. */
export function localMaterialIndex(geometry: Geometry, vertex: number, materialCount: number) {
  const attribute = geometry.materialIndex;
  if (!attribute) return 0;
  const index = attribute.array[vertex];
  if (attribute.itemSize === 1 && Number.isInteger(index) && index >= 0 && index < materialCount) return index;
  if (!warnedAttributes.has(attribute.array)) {
    warnedAttributes.add(attribute.array);
    console.warn('Invalid geometry.materialIndex; expected itemSize 1 and an index within mesh.materials. Falling back to material 0.');
  }
  return 0;
}

/** Writes the internal four-slot format; public vertices select one material at full weight. */
export function writeMaterialIndices(geometry: Geometry, globalIndices: number[], target: Int32Array, vertexOffset = 0, packDefault = false) {
  const count = geometry.vertexCount;
  target.fill(0, vertexOffset * 4, (vertexOffset + count) * 4);
  // Instanced geometry must retain the per-instance material fallback.
  if (!geometry.materialIndex && !packDefault) return;
  for (let vertex = 0; vertex < count; vertex++) {
    const local = localMaterialIndex(geometry, vertex, globalIndices.length);
    target[(vertexOffset + vertex) * 4] = Geometry.packMaterialIndexAndWeightToInt(globalIndices[local] ?? 0, 1);
  }
}
