import Geometry, {Attribute} from '../../../src/scene/Geometry.js';
import MaterialState from '../../../src/scene/MaterialState.js';
import {computeDisplacementMinmax, computeTrianglesDisplacementRange} from '../../../src/renderer/displacementPreparation.js';

export function displacementParameters(bytes: Uint8Array): Uint8Array {
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const size = u[0], flags = u[1];
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + flags * 11) % 256;
  const minmax = computeDisplacementMinmax(size, 4, i => pixels[i]);
  const geometry = new Geometry({position: new Attribute(new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]), 3),
    normal: new Attribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3),
    indices: new Attribute(new Uint32Array([0, 1, 2]), 1)});
  if (flags & 32) {
    const indices = new Uint32Array(300_000);
    for (let i = 0; i < indices.length; i++) indices[i] = i % 3;
    geometry.indices = new Attribute(indices, 1);
  }
  if (!(flags & 8)) geometry.uv = new Attribute(new Float32Array([-.2, .1, .9, .2, .3, 1.1]), 2);
  const material = new MaterialState();
  material.displacementUvProjection = (flags & 3) === 0 ? 'none' : (flags & 3) === 1 ? 'triplanar' : (flags & 3) === 2 ? 'spherical' : 'cylindrical';
  material.displacementUvProjectionScale = flags & 16 ? 2.3 : 1;
  const ranges = computeTrianglesDisplacementRange(geometry, minmax, size, !!(flags & 4), material);
  const rangeBytes = new Uint8Array(ranges.buffer);
  const result = new Uint8Array(minmax.reduce((sum, level) => sum + level.length, 0) + rangeBytes.length);
  let offset = 0;
  for (const level of minmax) {result.set(level, offset); offset += level.length;}
  result.set(rangeBytes, offset);
  return result;
}
