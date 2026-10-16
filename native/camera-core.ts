import Camera from '../src/scene/Camera.js';
import { mat4 } from '../src/math.js';
import { write } from '../src/math/access.js';
import { packCameraUniform } from '../src/renderer/cameraUniform.js';
import { cameraApertureRadius } from '../src/renderer/cameraLens.js';

// Decode the raw Camera[32] record. Full commits and partial camera updates use
// exactly the same existing TS camera/lens/math/packing implementation. Keep
// CPU matrix intermediates in Float64; the final GPU camera block stays Float32.
export function sceneCameraParameters(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, 32);
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, 32);
  const camera = u[0] === 0 ? new Camera({projection: 'perspective', fov: f[1], near: f[2], far: f[3]})
    : new Camera({projection: 'orthographic', left: f[4], right: f[5], bottom: f[6], top: f[7], near: f[2], far: f[3]});
  camera.zoom = f[8]; camera.fStop = f[9]; camera.focusDistance = f[10];
  camera.sensorHeight = f[11]; camera.metersPerUnit = f[12];
  for (let i = 0; i < 16; i++) write(camera.transform, i, f[16 + i]);
  const inverse = new Float64Array(16); mat4.invert(inverse, camera.getProjectionMatrix(width / height));
  mat4.mul(inverse, camera.transform, inverse);
  return new Uint8Array(packCameraUniform(new Float32Array(inverse), new Float32Array(camera.transform), cameraApertureRadius(camera), camera.focusDistance).buffer);
}
