import { cameraFocalLength, cameraApertureRadius } from '../../src/renderer/cameraLens';
import { describe, expect, it, vi } from 'vitest';
import Camera from '../../src/scene/Camera';
import CameraViewControl from '../../src/util/CameraViewControl';

describe('Camera', () => {
  it('uses valid perspective defaults', () => {
    const camera = new Camera({projection: 'perspective'});

    expect(camera.fov).toBe(45);
    expect(camera.aspect).toBeUndefined();
    expect(camera.near).toBe(0.1);
    expect(camera.far).toBe(2000);
    expect(Array.from(camera.getProjectionMatrix()).every(Number.isFinite)).toBe(true);
  });

  it('keeps explicit perspective parameters', () => {
    const camera = new Camera({projection: 'perspective', fov: 60, aspect: 16 / 9, near: 0.01, far: 500});
    expect(camera).toMatchObject({ fov: 60, aspect: 16 / 9, near: 0.01, far: 500 });
  });

  it('applies zoom to the perspective projection', () => {
    const camera = new Camera({projection: 'perspective', fov: 60, aspect: 16 / 9, near: 0.01, far: 500});
    const baseProjection = camera.getProjectionMatrix();
    camera.zoom = 2;
    const zoomedProjection = camera.getProjectionMatrix();

    expect(zoomedProjection[0]).toBeCloseTo(baseProjection[0] * 2);
    expect(zoomedProjection[5]).toBeCloseTo(baseProjection[5] * 2);
  });

  it('derives the lens radius from f-number, focal length and scene units', () => {
    const camera = new Camera({projection: 'perspective', fov: 45});
    expect(cameraApertureRadius(camera)).toBe(0);

    // 24 mm sensor at a 45° vertical field of view: f ≈ 28.97 mm.
    const focalLength = 12 / Math.tan(Math.PI / 8);
    expect(cameraFocalLength(camera)).toBeCloseTo(focalLength);
    camera.fStop = 2;
    expect(cameraApertureRadius(camera)).toBeCloseTo(focalLength / 4 / 1000);
    camera.metersPerUnit = 0.01;
    expect(cameraApertureRadius(camera)).toBeCloseTo(focalLength / 4 / 10);

    // Zoom lengthens the focal length and so the aperture at the same f-number.
    camera.zoom = 2;
    expect(cameraFocalLength(camera)).toBeCloseTo(focalLength * 2);

    camera.metersPerUnit = 0;
    expect(cameraApertureRadius(camera)).toBe(0);
    const ortho = new Camera({projection: 'orthographic'});
    ortho.fStop = 2;
    expect(cameraApertureRadius(ortho)).toBe(0);
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
    const control = new CameraViewControl({ camera: new Camera({projection: 'perspective'}), domElement: dom });

    control.dispose();

    expect(dom.removeEventListener).toHaveBeenCalledTimes(5);
    expect(dom.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(dom.removeEventListener).toHaveBeenCalledWith('wheel', expect.any(Function));
  });
});

it('uses target aspect automatically and honors an explicit override',()=>{
 const camera=new Camera({projection:'perspective'});
 const square=camera.getProjectionMatrix(1),wide=camera.getProjectionMatrix(2);
 expect(wide[0]).toBeCloseTo(square[0]/2);expect(wide[5]).toBe(square[5]);
 camera.aspect=3;expect(camera.getProjectionMatrix(2)[0]).toBeCloseTo(square[0]/3);
});
it('copies and clones settings without sharing transform storage',()=>{
 const source=new Camera({projection:'orthographic',left:-3,right:4,near:.2,far:42});source.position=[1,2,3];source.fStop=2;
 const clone=source.clone();expect(clone).toMatchObject({projection:'orthographic',left:-3,right:4,near:.2,far:42,fStop:2});expect(clone.transform).not.toBe(source.transform);
 clone.position=[4,5,6];expect(source.position).toEqual([1,2,3]);expect(clone.copy(source)).toBe(clone);expect(clone.position).toEqual([1,2,3]);
});
