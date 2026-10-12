import { writeMaterialIndices } from './materialIndices.js';
import { isDeformationUpdate } from '../scene/geometryChanges.js';
import Geometry from '../scene/Geometry.js';
import { buildBLAS, refitBLAS } from './bvhAccel.js';
import { getBvhBounds, updateMeshInstances } from './prepareMeshBVH.js';
import Mesh from '../scene/Mesh.js';

type Prepared = ReturnType<typeof updateMeshInstances>;
const vertexAttributes = ['position', 'normal', 'uv', 'uv1', 'color', 'tangent', 'materialIndex'] as const;
const bindingIndices = new WeakMap<Prepared, { source: Map<Geometry, Prepared['instanceBindings']>;
  prepared: Map<Geometry, Prepared['instanceBindings']> }>();
function indices(prepared: Prepared) {
  let maps = bindingIndices.get(prepared);
  if (!maps) {
    maps = { source: new Map(), prepared: new Map() };
    for (const binding of prepared.instanceBindings) {
      for (const [map, geometry] of [[maps.source, binding.mesh.geometry], [maps.prepared, binding.geometry]] as const) {
        let bindings = map.get(geometry);
        if (!bindings) map.set(geometry, bindings = []);
        bindings.push(binding);
      }
    }
    bindingIndices.set(prepared, maps);
  }
  return maps;
}

/** Displaced geometry must be prepared as a whole. */
export function canUpdateGeometries(prepared: Prepared, geometries: readonly Geometry[]) {
  return geometries.every(geometry => {
    const bindings = indices(prepared).source.get(geometry) ?? [];
    return bindings.length > 0 && bindings.every(b => !b.mesh.materials.some(m => m.displacementMap) &&
      b.geometry.position.array === geometry.position.array);
  });
}

/** Rewrites only a geometry's existing region, preserving global material indices. */
function copyRegion(source: Geometry, merged: Geometry, region: Prepared['geometryRegions'] extends Map<Geometry, infer R> ? R : never, topologyChanged: boolean, deformationOnly: boolean) {
  const { vertexOffset, indexOffset, materialIndices } = region;
  const count = Geometry.getVertexCount(source);
  for (const name of vertexAttributes) {
    if (name === 'materialIndex' || deformationOnly && name !== 'position' && name !== 'normal' && name !== 'tangent') continue;
    const target = merged[name]; if (!target) continue;
    const attribute = name === 'uv1' ? source.uv1 ?? source.uv : source[name];
    const offset = vertexOffset * target.itemSize;
    if (attribute) target.array.set(attribute.array, offset);
    else target.array.fill(0, offset, offset + count * target.itemSize);
  }
  if (!topologyChanged) return;
  writeMaterialIndices(source, materialIndices, merged.materialIndex!.array, vertexOffset);
  for (let i = 0; i < source.indices.array.length; i++) merged.indices.array[indexOffset + i] = source.indices.array[i] + vertexOffset;
}

/** Constant-time topology detection; markUpdated also covers in-place index edits. */
export function geometryTopologyChanged(prepared: Prepared | undefined, source: Geometry) {
  const state = prepared?.geometryStates.get(source);
  return !!state && (state.topologyVersion !== source.topologyVersion ||
    state.indices !== source.indices.array || state.indexCount !== source.indices.array.length);
}

/** Refits/rebuilds changed BLASes and refreshes all shared instances' cached bounds. */
export function updatePreparedGeometries(prepared: Prepared, changed: ReadonlySet<Geometry>) {
  const vertices: { first: number; count: number; topologyChanged: boolean; deformationOnly: boolean }[] = [];
  const blases: { blas: NonNullable<Geometry['bvh']>; offset: number }[] = [];
  const meshes = new Set<Mesh>();
  let resized = false, relocated = false, offset = 0;
  const updated = new Map<Geometry, NonNullable<Geometry['bvh']>>();
  prepared.geometries.forEach((geometry, i) => {
    const source = indices(prepared).prepared.get(geometry)?.[0].mesh.geometry ?? geometry;
    const previous = prepared.blases[i].bvh;
    if (changed.has(source)) {
      const region = prepared.geometryRegions.get(geometry)!;
      const topologyChanged = geometryTopologyChanged(prepared, source);
      const deformationOnly = !topologyChanged && isDeformationUpdate(source);
      let bvh = updated.get(source);
      if (!bvh) {
        bvh = source.bvh;
        if (topologyChanged || !bvh || source.dynamic && bvh.builder !== 'builtin' || !refitBLAS(bvh, source)) {
          bvh = buildBLAS(source);
        }
        source.bvh = bvh; updated.set(source, bvh);
      }
      geometry.bvh = bvh; geometry.version = source.version;
      prepared.blases[i].bvh = bvh;
      resized ||= previous.buffer.byteLength !== bvh.buffer.byteLength;
      relocated ||= previous.buffer.byteLength !== bvh.buffer.byteLength || previous.layout !== bvh.layout;
      copyRegion(source, prepared.geometry, region, topologyChanged, deformationOnly);
      const count = Geometry.getVertexCount(source), previousVertices = vertices[vertices.length - 1];
      if (previousVertices && previousVertices.first + previousVertices.count === region.vertexOffset && previousVertices.topologyChanged === topologyChanged && previousVertices.deformationOnly === deformationOnly) previousVertices.count += count;
      else vertices.push({first: region.vertexOffset, count, topologyChanged, deformationOnly});
      blases.push({blas: bvh, offset});
      for (const binding of indices(prepared).prepared.get(geometry) ?? []) {
        binding.bvhBounds = getBvhBounds(geometry); meshes.add(binding.mesh);
      }
    }
    offset += prepared.blases[i].bvh.buffer.byteLength;
  });
  for (const source of changed) prepared.geometryStates.set(source, { topologyVersion: source.topologyVersion,
    indices: source.indices.array, indexCount: source.indices.array.length });
  return { vertices, blases, meshes, resized, relocated };
}

/** Packs the same interleaved vertex layout for full and partial GPU uploads. */
export function packVertexAttributes(geometry: Geometry, output: Float32Array, stride: number,
  offsets: readonly number[], first: number, count: number, includeMaterialIndex = true, deformationOnly = false) {
  for (let k = 0; k < vertexAttributes.length; k++) {
    if (k === 6 && !includeMaterialIndex || deformationOnly && k >= 2 && k <= 4) continue;
    const attribute = geometry[vertexAttributes[k]];
    if (!attribute) continue;
    const array = attribute.array, size = attribute.itemSize;
    let destination = first * stride + offsets[k], source = first * size;
    for (let i = 0; i < count; i++, destination += stride, source += size) {
      for (let c = 0; c < size; c++) output[destination + c] = array[source + c];
    }
  }
}
