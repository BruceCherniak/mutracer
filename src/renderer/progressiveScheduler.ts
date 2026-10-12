/** Legacy interactive policy, independent of GPU execution and presentation. */
export class ProgressiveScheduler {
  preview = false;
  previewSamplePending = false;
  lastInteractionTime = -Infinity;
  enabled = true;
  idleDelayMs = 150;

  update(cameraChanged: boolean, sceneChanged: boolean, now: number): boolean {
    if (cameraChanged || (this.enabled && sceneChanged)) {
      this.lastInteractionTime = now;
      if (this.enabled) {
        this.preview = true;
        this.previewSamplePending = true;
      }
      return true;
    }
    if (this.preview && !this.previewSamplePending &&
        now - this.lastInteractionTime >= this.idleDelayMs) {
      this.preview = false;
      return true;
    }
    return false;
  }

  completeSample() { this.previewSamplePending = false; }

  configure(enabled: boolean, idleDelayMs: number) {
    this.enabled = enabled;
    this.idleDelayMs = Math.max(0, idleDelayMs);
    if (!enabled) {
      this.preview = false;
      this.previewSamplePending = false;
    }
  }
}
