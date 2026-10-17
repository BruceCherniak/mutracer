import {CAMERA as C} from './layout.js';
import Camera from '../src/scene/Camera.js';
import { mat4 } from '../src/math.js';
import { write } from '../src/math/access.js';
import { packCameraUniform } from '../src/renderer/cameraUniform.js';
import { cameraApertureRadius } from '../src/renderer/cameraLens.js';

// Decode the raw Camera[32] record. Full commits and partial camera updates use
// exactly the same existing TS camera/lens/math/packing implementation. Keep
// CPU matrix intermediates in Float64; the final GPU camera block stays Float32.
export function sceneCameraParameters(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, C.WORDS);
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, C.WORDS);
  const camera = u[C.PROJECTION] === 0 ? new Camera({projection: 'perspective', fov: f[C.FOV], near: f[C.NEAR], far: f[C.FAR]})
    : new Camera({projection: 'orthographic', left: f[C.LEFT], right: f[C.RIGHT], bottom: f[C.BOTTOM], top: f[C.TOP], near: f[C.NEAR], far: f[C.FAR]});
  camera.zoom = f[C.ZOOM]; camera.fStop = f[C.F_STOP]; camera.focusDistance = f[C.FOCUS_DISTANCE];
  camera.sensorHeight = f[C.SENSOR_HEIGHT]; camera.metersPerUnit = f[C.METERS_PER_UNIT];
  for (let i = 0; i < 16; i++) write(camera.transform, i, f[C.TRANSFORM + i]);
  const inverse = new Float64Array(16); mat4.invert(inverse, camera.getProjectionMatrix(width / height));
  mat4.mul(inverse, camera.transform, inverse);
  return new Uint8Array(packCameraUniform(new Float32Array(inverse), new Float32Array(camera.transform), cameraApertureRadius(camera), camera.focusDistance).buffer);
}
