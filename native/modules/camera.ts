import Camera from '../../src/scene/Camera.js';
import { cameraSnapshot } from '../../src/renderer/cameraSnapshot.js';
import { read, write } from '../../src/math/access.js';

export function cameraParameters(bytes: Uint8Array): Uint8Array {
  const input = new Uint32Array(bytes.buffer, bytes.byteOffset, 1);
  const flags = input[0];
  const camera = flags & 1
    ? new Camera({ projection: 'orthographic', left: -3, right: 2, bottom: -2, top: 4, near: .2, far: 80 })
    : new Camera({ projection: 'perspective', fov: 53, aspect: 1.5, near: .2, far: 80 });
  if (flags & 2) {
    const transform: number[] = [];
    for (let i = 0; i < 16; i++) transform.push(read(camera.transform, i));
    camera.transform = transform;
  }
  camera.position = [1.25, -2, 5];
  camera.lookAt(flags & 4 ? [1.25, 3, 5] : [-1, .5, 0]);
  if (flags & 2) write(camera.transform, 12, 1.25 + 1e-12);
  camera.zoom = flags & 8 ? 2 : 1;
  camera.fStop = 2.8; camera.focusDistance = 7; camera.sensorHeight = 36; camera.metersPerUnit = .01;
  const clone = camera.clone(), snapshot = cameraSnapshot(camera);
  const result = new ArrayBuffer(128 * 4 + 16), output = new Float32Array(result, 0, 128);
  const matrices = [camera.transform, camera.getProjectionMatrix(), clone.transform,
    clone.getProjectionMatrix(2), snapshot.transform, snapshot.getProjectionMatrix(2)];
  for (let m = 0; m < matrices.length; m++) for (let i = 0; i < 16; i++) output[m * 16 + i] = read(matrices[m], i);
  output.set([clone.fStop, clone.focusDistance, clone.sensorHeight, clone.metersPerUnit,
    read(camera.position, 0), read(camera.position, 1), read(camera.position, 2),
    camera.transform === clone.transform ? 1 : 0, camera.transform === snapshot.transform ? 1 : 0], 96);
  const precise = new Float64Array(result, 128 * 4, 2);
  precise[0] = read(camera.transform, 12); precise[1] = read(snapshot.transform, 12);
  return new Uint8Array(result);
}
