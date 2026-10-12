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

/** Copies internal update provenance to an engine-owned geometry snapshot. */
export function copyGeometryChangeState(source: Geometry, target: Geometry) {
  if (isDeformationUpdate(source)) deformationVersions.set(target, target.version);
  else deformationVersions.delete(target);
}
