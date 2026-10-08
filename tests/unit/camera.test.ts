import { describe, expect, it, vi } from 'vitest';
import Camera from '../../src/scene/Camera';
import CameraViewControl from '../../src/util/CameraViewControl';

describe('Camera', () => {
  it('uses valid perspective defaults', () => {
    const camera = new Camera('perspective');

    expect(camera.fov).toBe(45);
    expect(camera.aspect).toBe(1);
    expect(camera.near).toBe(0.1);
    expect(camera.far).toBe(2000);
    expect(Array.from(Camera.getProjectionMatrix(camera)).every(Number.isFinite)).toBe(true);
  });

  it('keeps explicit perspective parameters', () => {
    const camera = new Camera('perspective', 60, 16 / 9, 0.01, 500);
    expect(camera).toMatchObject({ fov: 60, aspect: 16 / 9, near: 0.01, far: 500 });
  });

  it('applies zoom to the perspective projection', () => {
    const camera = new Camera('perspective', 60, 16 / 9, 0.01, 500);
    const baseProjection = Camera.getProjectionMatrix(camera);
    camera.zoom = 2;
    const zoomedProjection = Camera.getProjectionMatrix(camera);

    expect(zoomedProjection[0]).toBeCloseTo(baseProjection[0] * 2);
    expect(zoomedProjection[5]).toBeCloseTo(baseProjection[5] * 2);
  });
});

describe('CameraViewControl lifecycle', () => {
  it('removes its DOM listeners when disposed', () => {
    const dom = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      clientWidth: 800,
      clientHeight: 600
    } as unknown as HTMLElement;
    const control = new CameraViewControl({ camera: new Camera('perspective'), domElement: dom });

    control.dispose();

    expect(dom.removeEventListener).toHaveBeenCalledTimes(5);
    expect(dom.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(dom.removeEventListener).toHaveBeenCalledWith('wheel', expect.any(Function));
  });
});
