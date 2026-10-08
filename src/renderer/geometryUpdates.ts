import Geometry from '../scene/Geometry';
import { buildBLAS, flattenBvh, refitBLAS } from './bvhAccel';
import { getBvhBounds, updateMeshInstances } from './prepareMeshBVH';
import Mesh from '../scene/Mesh';

type Prepared = ReturnType<typeof updateMeshInstances>;
const vertexAttributes = ['position', 'normal', 'uv', 'uv1', 'color', 'tangent', 'materialIndex'] as const;

/** Evaluated displacement and simplified geometry must be regenerated as a whole. */
export function canUpdateGeometries(prepared: Prepared, geometries: readonly Geometry[]) {
  return geometries.every(geometry => {
    const bindings = prepared.instanceBindings.filter(b => b.mesh.geometry === geometry);
    return bindings.length > 0 && bindings.every(b => !b.mesh.materials.some(m => m.displacementMap) &&
      (b.mesh.geometrySimplificationRatio ?? 1) === 1 && b.geometry.position.array === geometry.position.array);
  });
}

/** Rewrites only a geometry's existing region, preserving global material indices. */
function copyRegion(source: Geometry, merged: Geometry, region: Prepared['geometryRegions'] extends Map<Geometry, infer R> ? R : never) {
  const { vertexOffset, indexOffset, materialIndices } = region;
  const count = Geometry.getVertexCount(source);
  for (const name of vertexAttributes) {
    if (name === 'materialIndex') continue;
    const target = merged[name]; if (!target) continue;
    const attribute = name === 'uv1' ? source.uv1 ?? source.uv : source[name];
    const offset = vertexOffset * target.itemSize;
    if (attribute) target.array.set(attribute.array, offset);
    else target.array.fill(0, offset, offset + count * target.itemSize);
  }
  const target = merged.materialIndex!.array;
  for (let i = 0; i < count * 4; i++) {
    const local = source.materialIndex?.array[i] ?? 0;
    const [index, weight] = Geometry.unpackMaterialIndexAndWeightFromInt(local);
    target[vertexOffset * 4 + i] = local > 0 ? Geometry.packMaterialIndexAndWeightToInt(materialIndices[index] ?? 0, weight) : 0;
  }
  for (let i = 0; i < source.indices.array.length; i++) merged.indices.array[indexOffset + i] = source.indices.array[i] + vertexOffset;
}

/** The index array may have been edited in place; compare against the accepted merged stream. */
export function geometryTopologyChanged(prepared: Prepared | undefined, source: Geometry) {
  if (!prepared) return false;
  const binding = prepared.instanceBindings.find(b => b.mesh.geometry === source);
  const region = binding && prepared.geometryRegions.get(binding.geometry);
  return !!region && source.indices.array.some((index, i) =>
    prepared.geometry.indices.array[region.indexOffset + i] !== index + region.vertexOffset);
}

/** Refits/rebuilds changed BLASes and refreshes all shared instances' cached bounds. */
export function updatePreparedGeometries(prepared: Prepared, changed: ReadonlySet<Geometry>) {
  const vertices: { first: number; count: number }[] = [];
  const blases: { blas: NonNullable<Geometry['bvh']>; offset: number }[] = [];
  const meshes = new Set<Mesh>();
  let resized = false, relocated = false, offset = 0;
  const updated = new Map<Geometry, NonNullable<Geometry['bvh']>>();
  prepared.geometries.forEach((geometry, i) => {
    const source = prepared.instanceBindings.find(b => b.geometry === geometry)?.mesh.geometry ?? geometry;
    const previous = prepared.blases[i].bvh;
    if (changed.has(source)) {
      const region = prepared.geometryRegions.get(geometry)!;
      const topologyChanged = source.indices.array.some((index, j) =>
        prepared.geometry.indices.array[region.indexOffset + j] !== index + region.vertexOffset);
      let bvh = updated.get(source);
      if (!bvh) {
        bvh = source.bvh;
        if (topologyChanged || !bvh || source.dynamic && bvh.builder !== 'builtin' || !refitBLAS(bvh, source)) {
          bvh = flattenBvh(buildBLAS(source, 0, undefined), false);
        }
        source.bvh = bvh; updated.set(source, bvh);
      }
      geometry.bvh = bvh; geometry.version = source.version;
      prepared.blases[i].bvh = bvh;
      resized ||= previous.buffer.byteLength !== bvh.buffer.byteLength;
      relocated ||= previous.buffer.byteLength !== bvh.buffer.byteLength || previous.layout !== bvh.layout;
      copyRegion(source, prepared.geometry, region);
      vertices.push({first: region.vertexOffset, count: Geometry.getVertexCount(source)});
      blases.push({blas: bvh, offset});
      for (const binding of prepared.instanceBindings) if (binding.geometry === geometry) {
        binding.bvhBounds = getBvhBounds(geometry); meshes.add(binding.mesh);
      }
    }
    offset += prepared.blases[i].bvh.buffer.byteLength;
  });
  return { vertices, blases, meshes, resized, relocated };
}

/** Packs the same interleaved vertex layout for full and partial GPU uploads. */
export function packVertexAttributes(geometry: Geometry, output: Float32Array, stride: number,
  offsets: readonly number[], first: number, count: number) {
  for (let i = first; i < first + count; i++) {
    for (let k = 0; k < vertexAttributes.length; k++) {
      const attribute = geometry[vertexAttributes[k]];
      if (attribute) for (let component = 0; component < attribute.itemSize; component++) {
        output[i * stride + offsets[k] + component] = attribute.array[i * attribute.itemSize + component];
      }
    }
  }
}
