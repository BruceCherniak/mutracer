import { describe, expect, it } from 'vitest';
import { ProgressiveScheduler } from '../../src/renderer/progressiveScheduler';

describe('legacy progressive scheduling', () => {
  it('keeps preview through preparation and compilation until one sample completes', () => {
    const scheduler = new ProgressiveScheduler();
    expect(scheduler.update(false, true, 0)).toBe(true);
    expect(scheduler.preview).toBe(true);
    expect(scheduler.update(false, false, 200)).toBe(false);
    expect(scheduler.preview).toBe(true);
    scheduler.completeSample();
    expect(scheduler.update(false, false, 201)).toBe(true);
    expect(scheduler.preview).toBe(false);
  });

  it('extends the idle deadline for camera and scene edits', () => {
    const scheduler = new ProgressiveScheduler();
    scheduler.update(true, false, 0);
    scheduler.completeSample();
    scheduler.update(false, true, 100);
    scheduler.completeSample();
    expect(scheduler.update(false, false, 249)).toBe(false);
    expect(scheduler.update(false, false, 250)).toBe(true);
  });

  it('restarts the camera without preview when preview is disabled', () => {
    const scheduler = new ProgressiveScheduler();
    scheduler.configure(false, 150);
    expect(scheduler.update(true, false, 0)).toBe(true);
    expect(scheduler.preview).toBe(false);
    expect(scheduler.update(false, true, 1)).toBe(false);
  });

  it('immediately leaves preview when disabled', () => {
    const scheduler = new ProgressiveScheduler();
    scheduler.update(true, false, 0);
    scheduler.configure(false, 0);
    expect(scheduler.preview).toBe(false);
    expect(scheduler.previewSamplePending).toBe(false);
  });
});
