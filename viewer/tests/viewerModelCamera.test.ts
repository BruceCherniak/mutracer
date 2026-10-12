import { describe, expect, it } from 'vitest';
import { readModelCamera } from '../src/engine/modelCamera';

describe('asset default camera', () => {
  const camera = { position: [3, 1, 4], target: [0, 1, 0], fov: 45, space: 'grounded' };
  it('accepts cameras in the same coordinate space as the grounded viewer model', () => {
    expect(readModelCamera(camera)).toEqual(camera);
  });
  it('ignores malformed cameras rather than breaking model loading', () => {
    for (const value of [null, {}, {...camera,space:'source'}, {...camera,position:[Infinity,1,4]},
      {...camera,position:camera.target}, {...camera,fov:180}, {...camera,target:[0,1]}]) {
      expect(readModelCamera(value)).toBeNull();
    }
  });
});
