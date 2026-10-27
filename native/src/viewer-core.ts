import {sunPosition} from '../../src/scene/skyParameters.js';
import {studioPanel, studioAmbientValue} from '../../src/util/studioLighting.js';

// Low-frequency viewer calculations share the existing AOT runtime. RenderLoop
// scheduling stays on its native host clock and never calls this entry point.
export function viewerParameters(kind: number, bytes: Uint8Array): Uint8Array {
  const a = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
  let result: number[];
  if (kind === 0) {
    const sun = sunPosition(a[0]);
    result = [sun.elevation, sun.azimuth];
  } else if (kind === 1) {
    result = studioPanel(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13]);
  } else {
    result = [];
    for (let row = 0; row < 32; row++) { result.push(studioAmbientValue(row,32)); }
  }
  return new TextEncoder().encode(JSON.stringify(result));
}
