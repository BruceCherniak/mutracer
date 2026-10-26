import type {AovSceneSource} from './aovScene.js';
import type {FlattendBVH} from './bvhAccel.js';
import type Geometry from '../scene/Geometry.js';
import {AOV_BACKGROUND_ID} from './aov.js';

/** Web AOV identity data is independent of camera, transforms and materials. */
export class AovPrimitiveCache {
  private blases = new WeakMap<ArrayBuffer, {
    geometry: Geometry; indices: Uint16Array | Uint32Array; topology: number;
    triangleIds?: Uint32Array; ids: Uint32Array;
  }>();
  private parts: Uint32Array[] = [];
  private tlasRecords = -1;
  private combined?: Uint32Array;

  get(source: Pick<AovSceneSource, 'blases' | 'geometries'>, tlas: FlattendBVH) {
    const parts = source.blases.map((blas, index) => {
      const geometry = source.geometries[index], indices = geometry.indexArray;
      const buffer = blas.bvh.buffer, triangleIds = blas.bvh.triangleIds;
      const cached = this.blases.get(buffer);
      if (cached && cached.geometry === geometry && cached.indices === indices &&
          cached.topology === geometry.topologyVersion && cached.triangleIds === triangleIds) return cached.ids;
      const bvh = new Uint32Array(buffer), ids = new Uint32Array(bvh.length / 4).fill(AOV_BACKGROUND_ID);
      const triangles = new Map<string, number>();
      for (let t = 0; t < indices.length / 3; t++) triangles.set(`${indices[t*3]},${indices[t*3+1]},${indices[t*3+2]}`, t);
      for (let record = 0; record < ids.length; record++) {
        const triangle = triangles.get(`${bvh[record*4]},${bvh[record*4+1]},${bvh[record*4+2]}`);
        if (triangle !== undefined) ids[record] = triangle;
      }
      // Builder metadata distinguishes displaced/duplicate index triples.
      if (triangleIds) for (let i = 0; i < triangleIds.length; i += 2) ids[triangleIds[i]] = triangleIds[i+1];
      this.blases.set(buffer, {geometry, indices, topology: geometry.topologyVersion, triangleIds, ids});
      return ids;
    });
    const tlasRecords = tlas.buffer.byteLength / 16;
    if (!this.combined || this.tlasRecords !== tlasRecords || parts.length !== this.parts.length ||
        parts.some((part, i) => part !== this.parts[i])) {
      const combined = new Uint32Array(tlasRecords + parts.reduce((count, part) => count + part.length, 0)).fill(AOV_BACKGROUND_ID);
      let offset = tlasRecords;
      for (const part of parts) { combined.set(part, offset); offset += part.length; }
      this.combined = combined; this.parts = parts; this.tlasRecords = tlasRecords;
    }
    return this.combined;
  }
}
