import Geometry from './Geometry.js';

// A deformation evaluator knows precisely which attributes it has written.
// Ordinary public notifications still cover every vertex attribute.
const deformationVersions = new WeakMap<Geometry, number>();
export function markDeformedGeometry(geometry: Geometry) {
  geometry.markVerticesUpdated();
  deformationVersions.set(geometry, geometry.version);
}
export function isDeformationUpdate(geometry: Geometry) {
  return deformationVersions.get(geometry) === geometry.version;
}
