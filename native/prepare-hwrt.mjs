import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShaderIdentifierMap, renameShaderIdentifiers } from '../scripts/shader-identifiers.mjs';

// Read the actual uploaded BVH/instance records, including TLAS leaf-order IDs.
// This first capture supports BVH2, opaque alpha and no displacement/bevel.
export function prepareHardwareCapture(pass, save, source) {
  const unsupported = pass._hasDisplacement || pass._constants.HAS_ALPHA || pass._rtUniform.views.bevel[0] !== 0;
  if (unsupported) return { eligible: false, reason: 'Requires opaque alpha, no displacement and no shader bevel.' };
  const instances = new Float32Array(pass._instancesBuffer.data.buffer);
  const instanceWords = new Uint32Array(instances.buffer);
  const bvh = new Int32Array(pass._bvhBuffer.data.buffer);
  const attributes = pass._attributeData;
  const stride = pass._attributeStride, positionOffset = pass._attributeOffsets[0];
  const count = instances.length / 40;
  if (!count) return { eligible: false, reason: 'Initial hardware capture requires a nonempty scene.' };
  const map = new Array(count).fill(0), geometries = [], placements = [], cache = new Map();
  let hardwareClosest = true;
  for (let id = 0; id < count; id++) {
    const encoded = instanceWords[id * 40];
    if ((encoded >>> 30) !== 0) return { eligible: false, reason: 'Initial native hardware capture supports BVH2 only.' };
    const root = pass._rtUniform.views.blasOffset[0] + encoded;
    const vertexOffset = instanceWords[id * 40 + 1];
    const key = `${root}:${vertexOffset}`;
    let geometry = cache.get(key);
    if (geometry === undefined) {
      const records = [], positions = [];
      function visit(node) {
        const rightOrCount = bvh[node * 4 + 3];
        if (rightOrCount >= 0) { visit(node + 2); visit(root + rightOrCount); return; }
        for (let k = 0; k < -rightOrCount; k++) {
          const record = node + 2 + k; records.push(record);
          for (let corner = 0; corner < 3; corner++) {
            const vertex = bvh[record * 4 + corner] + vertexOffset;
            const offset = vertex * stride + positionOffset;
            positions.push(attributes[offset], attributes[offset + 1], attributes[offset + 2]);
          }
        }
      }
      visit(root);
      if (!positions.length || !positions.every(Number.isFinite)) throw new Error('Invalid hardware triangle geometry');
      geometry = geometries.length;
      const base = map.length; map.push(...records);
      geometries.push({ positions: save(`hwrt-positions-${geometry}.bin`, new Uint8Array(new Float32Array(positions).buffer)),
        vertexCount: positions.length / 3, mapBase: base });
      cache.set(key, geometry);
    }
    map[id] = geometries[geometry].mapBase;
    const m = instances.subarray(id * 40 + 20, id * 40 + 36);
    const a = [m[0], m[1], m[2]], b = [m[4], m[5], m[6]], c = [m[8], m[9], m[10]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const scale = Math.max(dot(a, a), dot(b, b), dot(c, c));
    const epsilon = scale * 1e-5;
    const determinant = a[0] * (b[1] * c[2] - b[2] * c[1])
      - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
    // Broader affine closest-hit parity is unresolved. Keep its exact software
    // traversal for the whole scene; hardware shadow queries remain available.
    hardwareClosest &&= determinant > 0 && scale > 0
      && Math.abs(dot(a, a) - dot(b, b)) <= epsilon && Math.abs(dot(a, a) - dot(c, c)) <= epsilon
      && Math.abs(dot(a, b)) <= epsilon && Math.abs(dot(a, c)) <= epsilon && Math.abs(dot(b, c)) <= epsilon;
    placements.push({ geometry, customIndex: id,
      transform: [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]] });
  }
  const identifiers = loadShaderIdentifierMap();
  for (const name of ['intersectScene', 'intersectSceneShadow']) {
    const marker = `fn ${identifiers.get(name) ?? name}(`;
    if (source.split(marker).length !== 2) throw new Error(`Unexpected MuTracer ${name} definition count`);
    source = source.replace(marker, `fn ${name}Software(`);
  }
  const validateShadows = process.env.MUTRACER_NATIVE_VALIDATE_SHADOWS === '1';
  const wrapper = renameShaderIdentifiers(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'hwrt-intersect.wgsl'), 'utf8')
    .replace('const MT_VALIDATE_SHADOWS: bool = false;', `const MT_VALIDATE_SHADOWS: bool = ${validateShadows};`)
    .replace('const MT_SOFTWARE_CLOSEST: bool = false;', `const MT_SOFTWARE_CLOSEST: bool = ${!hardwareClosest};`), identifiers);
  const shader = `enable wgpu_ray_query;\n${source}\n${wrapper}`;
  return { eligible: true, hardwareClosest, validateShadows, geometries, instances: placements,
    triangleMap: save('hwrt-triangle-map.bin', new Uint8Array(new Uint32Array(map).buffer)),
    shader: save('raytrace-hwrt.wgsl', shader),
    scope: 'Hardware closest and shadow triangle selection; original exact triangle/attribute evaluation and conservative software fallbacks.' };
}
