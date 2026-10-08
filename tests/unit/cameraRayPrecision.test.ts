import { expect, it } from 'vitest';
import { mat4, vec4 } from 'gl-matrix';
import Camera from '../../src/scene/Camera';
import rayTraceCompute from '../../src/renderer/wgsl/rayTrace.compute';

function endpoints(camera: Camera) {
  const inverse = mat4.invert(mat4.create(), Camera.getProjectionMatrix(camera))!;
  return [-1, 1].map(z => vec4.transformMat4(vec4.create(), [0.3, -0.2, z, 1], inverse));
}
function direction(origin: Float32Array, target: Float32Array) {
  const d = [0,1,2].map(i => target[i] * origin[3] - origin[i] * target[3]);
  return d.map(v => v / Math.hypot(...d));
}
it('keeps rays finite when an imported far clip rounds to infinity in f32', () => {
  const [origin,target] = endpoints(new Camera('perspective', 60, 16/9, 0.001, 100000));
  expect(target[3]).toBe(0);
  const ray = direction(origin as Float32Array,target as Float32Array);
  expect(ray.every(Number.isFinite)).toBe(true);
  expect(ray[2]).toBeLessThan(0);
  const shader = rayTraceCompute({hasDisplacement:false,hasAlpha:false});
  expect(shader).toContain('normalize(center.xyz * origin.w - origin.xyz * center.w)');
});
it.each([new Camera('perspective',45,1.5,0.1,1000),new Camera('orthographic',-2,2,-1,1,0.1,1000)])('preserves ordinary perspective and orthographic ray direction', camera => {
  const [origin,target] = endpoints(camera);
  const old = [0,1,2].map(i=>target[i]/target[3]-origin[i]/origin[3]);
  const expected = old.map(v=>v/Math.hypot(...old));
  const result=direction(origin as Float32Array,target as Float32Array);
  result.forEach((v,i)=>expect(v).toBeCloseTo(expected[i],6));
});
