import { OrthographicCamera, PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RenderLoop from '../../src/RenderLoop';
import { THREESync } from '../../src/util/fromTHREE';
import { renderFixture } from '../helpers/renderPipeline';

afterEach(() => {vi.restoreAllMocks();});

function fixture(fps = 60, orthographic = false) {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const {engine} = renderFixture(); const camera = orthographic ? new OrthographicCamera() : new PerspectiveCamera(); camera.position.set(3, 2, 5);
  const document = new EventTarget();
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: document, style: {}, clientWidth: 800, clientHeight: 600,
    getRootNode: () => document, setPointerCapture() {}, releasePointerCapture() {}
  });
  const controls = new OrbitControls(camera, canvas as unknown as HTMLElement); controls.enableDamping = true; controls.dampingFactor = .2;
  const update = vi.spyOn(controls, 'update');
  const sync = new THREESync(engine, {camera, controls}); const loop = new RenderLoop(engine, {sync});
  loop.tick();
  return {engine, camera, controls, update, sync, loop,
    tick() {now += 1000 / fps; return loop.tick();},
    pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', x = 100, y = 100) {
      const event = Object.assign(new Event(type), {
        pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y,
        ctrlKey: false, metaKey: false, shiftKey: false
      });
      (type === 'pointerdown' ? canvas : document).dispatchEvent(event);
    },
    get elapsed() {return now;},
    dispose() {loop.dispose(); sync.dispose(); controls.dispose(); engine.dispose();}
  };
}

describe('THREESync OrbitControls lifecycle', () => {
  it('uses elapsed time for damping at different render frame rates', () => {
    const positions = [20, 30, 60, 120].map(fps => {
      const f = fixture(fps); const initialAngle = f.controls.getAzimuthalAngle();
      f.controls.dispatchEvent({type: 'start'}); f.controls.rotateLeft(.3); f.controls.update(); f.controls.dispatchEvent({type: 'end'});
      for (let i = 0; i < fps * .3; i++) f.tick();
      expect(Math.abs(f.controls.getAzimuthalAngle() - initialAngle + .3)).toBeLessThan(.005);
      expect(f.controls.dampingFactor).toBe(.2);
      const position = f.camera.position.clone(); f.dispose(); return position;
    });
    for (const position of positions) expect(position.distanceTo(positions[0])).toBeLessThan(1e-12);
  });

  it.each([10, 20, 60, 120])('ends motion once at an orbit pole and keeps accumulating at %s fps', fps => {
    const f = fixture(fps);
    f.controls.dispatchEvent({type: 'start'}); f.controls.rotateUp(Math.PI); f.controls.rotateLeft(.2); f.controls.update(); f.tick();
    f.controls.dispatchEvent({type: 'end'});
    for (let i = 0; i < fps; i++) {f.tick(); if (!f.loop.changing && f.loop.final.samples > 0) break;}
    expect(f.loop.changing).toBe(false); expect(f.elapsed).toBeLessThan(500);
    const revision = f.engine._inputs.camera, samples = f.loop.final.samples;
    f.update.mockClear();
    for (let i = 1; i <= 30; i++) {
      expect(f.tick()).toBe('converging'); expect(f.loop.final.samples).toBe(samples + i);
      expect(f.engine._inputs.camera).toBe(revision);
    }
    expect(f.update).not.toHaveBeenCalled(); f.dispose();
  });

  it('wakes stopped controls for exact source edits, control options and new gestures', () => {
    const f = fixture(); f.update.mockClear(); f.tick(); expect(f.update).not.toHaveBeenCalled();
    const revision = f.engine._inputs.camera;
    f.camera.position.x += 8 * Number.EPSILON; f.tick();
    expect(f.update).toHaveBeenCalled(); expect(f.engine._inputs.camera).toBeGreaterThan(revision);
    expect(Array.from(f.engine.camera!.transform)).toEqual(f.camera.matrixWorld.elements);
    f.update.mockClear(); f.controls.maxDistance = 3; f.tick(); expect(f.update).toHaveBeenCalled();
    expect(f.camera.position.distanceTo(f.controls.target)).toBeCloseTo(3);
    f.tick(); f.update.mockClear();
    f.controls.dispatchEvent({type: 'start'}); f.controls.rotateLeft(.2); f.controls.update();
    expect(f.tick()).toBe('previewing'); expect(f.update).toHaveBeenCalled();
    f.controls.dispatchEvent({type: 'end'}); f.tick(); f.dispose();
  });

  it.each([
    {damping: false, orthographic: false}, {damping: true, orthographic: false},
    {damping: false, orthographic: true}, {damping: true, orthographic: true}
  ])('preserves accumulation on clicks: %j', ({damping, orthographic}) => {
    const f = fixture(60, orthographic); f.controls.enableDamping = damping; f.tick(); f.tick();
    const revision = f.engine._inputs.camera, samples = f.loop.final.samples;
    const position = f.camera.position.clone(), quaternion = f.camera.quaternion.clone();
    f.update.mockClear();
    f.pointer('pointerdown');
    for (let i = 1; i <= 3; i++) {
      expect(f.tick()).toBe('converging'); expect(f.loop.changing).toBe(false);
      expect(f.loop.final.samples).toBe(samples + i);
    }
    f.pointer('pointerup');
    expect(f.tick()).toBe('converging'); expect(f.loop.final.samples).toBe(samples + 4);
    expect(f.engine._inputs.camera).toBe(revision); expect(f.update).not.toHaveBeenCalled();
    expect(f.camera.position.equals(position)).toBe(true); expect(f.camera.quaternion.equals(quaternion)).toBe(true);
    f.dispose();
  });

  it('keeps a completed image idle through a click and wakes for a drag', () => {
    const f = fixture(); f.loop.final.maxSamples = 3;
    for (let i = 0; i < 5; i++) f.tick();
    expect(f.loop.status).toBe('finished');
    const revision = f.engine._inputs.camera;
    f.update.mockClear(); f.pointer('pointerdown');
    expect(f.tick()).toBe('finished'); expect(f.sync.active).toBe(false);
    f.pointer('pointerup');
    expect(f.tick()).toBe('finished'); expect(f.loop.final.samples).toBe(3);
    expect(f.engine._inputs.camera).toBe(revision); expect(f.update).not.toHaveBeenCalled();
    f.pointer('pointerdown'); f.pointer('pointermove', 120, 100);
    expect(f.tick()).toBe('previewing'); expect(f.sync.active).toBe(true);
    expect(f.engine._inputs.camera).toBeGreaterThan(revision);
    f.pointer('pointerup', 120, 100);
    for (let i = 0; i < 60 && f.loop.status !== 'finished'; i++) f.tick();
    expect(f.loop.status).toBe('finished'); expect(f.loop.final.samples).toBe(3);
    f.dispose();
  });
});
