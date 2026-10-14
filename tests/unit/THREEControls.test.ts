import { PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RenderLoop from '../../src/RenderLoop';
import { THREESync } from '../../src/util/fromTHREE';
import { renderFixture } from '../helpers/renderPipeline';

afterEach(() => {vi.restoreAllMocks();});

function fixture(fps = 60) {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const {engine} = renderFixture(); const camera = new PerspectiveCamera(); camera.position.set(3, 2, 5);
  const controls = new OrbitControls(camera); controls.enableDamping = true; controls.dampingFactor = .2;
  const update = vi.spyOn(controls, 'update');
  const sync = new THREESync(engine, {camera, controls}); const loop = new RenderLoop(engine, {sync});
  loop.tick();
  return {engine, camera, controls, update, sync, loop,
    tick() {now += 1000 / fps; return loop.tick();},
    get elapsed() {return now;},
    dispose() {loop.dispose(); sync.dispose(); engine.dispose();}
  };
}

describe('THREESync OrbitControls lifecycle', () => {
  it('uses elapsed time for damping at different render frame rates', () => {
    const positions = [20, 30, 60, 120].map(fps => {
      const f = fixture(fps); const initialAngle = f.controls.getAzimuthalAngle();
      f.controls.dispatchEvent({type: 'start'}); f.controls.rotateLeft(.3); f.controls.dispatchEvent({type: 'end'});
      for (let i = 0; i < fps * .3; i++) f.tick();
      expect(Math.abs(f.controls.getAzimuthalAngle() - initialAngle + .3)).toBeLessThan(.005);
      expect(f.controls.dampingFactor).toBe(.2);
      const position = f.camera.position.clone(); f.dispose(); return position;
    });
    for (const position of positions) expect(position.distanceTo(positions[0])).toBeLessThan(1e-12);
  });

  it.each([10, 20, 60, 120])('ends motion once at an orbit pole and keeps accumulating at %s fps', fps => {
    const f = fixture(fps);
    f.controls.dispatchEvent({type: 'start'}); f.controls.rotateUp(Math.PI); f.controls.rotateLeft(.2); f.tick();
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
    f.controls.dispatchEvent({type: 'start'}); expect(f.tick()).toBe('previewing'); expect(f.update).toHaveBeenCalled();
    f.controls.dispatchEvent({type: 'end'}); f.tick(); f.dispose();
  });
});
