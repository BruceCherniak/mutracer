import type { Scene } from '../scene/Scene.js';
import type { TraceSettings } from './renderPipeline.js';
import type { RenderPasses } from './RenderingPipeline.js';

/** Backend-owned execution and outputs of one resident accumulation. */
export interface TargetPipeline extends RenderPasses {
  activate(): void;
  invalidateDenoisedOutput(): void;
  configure(settings: TraceSettings): void;
  synchronizeBackground(background: Scene['background']): void;
  canCompleteSampleWithin(timeBudgetMs: number): boolean;
  present(): void;
  readPresentation(): Promise<{width: number; height: number; data: Float32Array}>;
  readonly presentationComplete: boolean;
  readonly presentationDenoised: boolean;
  getMemory(): {width: number; height: number; bytes: number};
}
