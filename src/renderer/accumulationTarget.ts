import Camera from '../scene/Camera.js';
import type { TraceSettings } from './renderPipeline.js';
import type { RenderingPipeline } from './RenderingPipeline.js';
import { ProgressiveScheduler } from './progressiveScheduler.js';

/** Configuration of a resident accumulation, independent of presentation. */
export interface AccumulationTargetOptions {
  label?: string;
  preview?: boolean;
  independent?: boolean;
}

/** Backend-owned execution and output of one resident accumulation. */
export interface TargetPipeline extends Omit<RenderingPipeline, 'needsRestartSample' | 'isPreviewMode'> {
  activate(): void;
  configure(settings: TraceSettings): void;
  synchronizeBackground(background: Parameters<RenderingPipeline['setBackground']>[0]): void;
  invalidate(): void;
  begin(): void;
  canCompleteSampleWithin(timeBudgetMs: number): boolean;
  present(): void;
  readPresentation(): Promise<{width: number; height: number; data: Float32Array}>;
  readonly presentationComplete: boolean;
  readonly presentationDenoised: boolean;
  getMemory(): { width: number; height: number; bytes: number };
}

export interface InternalAccumulationTarget {
  readonly label: string;
  readonly pipeline: TargetPipeline;
  fallback?: InternalAccumulationTarget;
  /** Shared-input generation this target must accumulate. */
  inputRevision: number;
  settingsRevision: number;
  /** Generation last submitted by this target. */
  accumulatedRevision: number;
}

export interface ResidentRenderingPipeline extends RenderingPipeline {
  readonly finalTarget: InternalAccumulationTarget;
  readonly previewTarget: InternalAccumulationTarget;
  createTarget(options?: AccumulationTargetOptions): InternalAccumulationTarget;
  drawTarget(target: InternalAccumulationTarget, camera: Camera, options: { sampleTarget: number; timeBudgetMs: number }): boolean;
  canCompleteSampleWithin(target: InternalAccumulationTarget, timeBudgetMs: number): boolean;
  present(target: InternalAccumulationTarget): void;
}

/** Adapts the legacy Renderer policy to resident backend targets. */
export function makeProgressivePipeline(
  create: (options: AccumulationTargetOptions, onComplete: (complete?: boolean) => void) => TargetPipeline,
  cameraChanged: (camera: Camera) => boolean,
  disposeScene: () => void
): ResidentRenderingPipeline {
  const scheduler = new ProgressiveScheduler();
  const targets: InternalAccumulationTarget[] = [];
  let inputRevision = 0;
  const savedSettings = new Map<keyof TargetPipeline, unknown[]>();
  let active: InternalAccumulationTarget;
  let presented: InternalAccumulationTarget | undefined;
  let denoisePreview = false;
  let callback: Parameters<RenderingPipeline['setOnSampleRendered']>[0] = () => {};

  function createTarget(options: AccumulationTargetOptions = {}) {
    const target: InternalAccumulationTarget = {
      label: options.label ?? `target-${targets.length}`,
      inputRevision,
      settingsRevision: 0,
      accumulatedRevision: -1,
      pipeline: create(options, (complete = true) => {
        if (active === target) {
          if (complete) scheduler.completeSample();
          else if (scheduler.preview) scheduler.previewSamplePending = true;
        }

      })
    };
    targets.push(target);
    target.pipeline.activate();
    for (const [method, args] of savedSettings) {
      const fn = target.pipeline[method] as (...args: unknown[]) => unknown;
      fn?.apply(target.pipeline, args);
    }
    active?.pipeline.activate();
    target.pipeline.setOnSampleRendered((...args) => {
      if (active === target) callback(...args);
    });
    return target;
  }
  const final = createTarget({ label: 'final' });
  const preview = createTarget({ label: 'preview', preview: true });
  final.fallback = preview;
  active = final;

  function present(target: InternalAccumulationTarget) {
    const holdDenoise = denoisePreview && presented?.pipeline.presentationDenoised && !target.pipeline.presentationDenoised;
    const ready = !holdDenoise && target.pipeline.presentationComplete && target.pipeline.getTotalSamplesRendered() > 0 && !target.pipeline.isFirstFrame() &&
      !(target === final && denoisePreview && !target.pipeline.presentationDenoised &&
        preview.pipeline.presentationComplete);
    const candidate = holdDenoise ? presented : ready ? target : target.fallback?.pipeline.presentationComplete
      ? target.fallback : presented;
    if (candidate?.pipeline.presentationComplete) {
      candidate.pipeline.present();
      presented = candidate;
    }
  }
  function select() {
    const next = scheduler.preview ? preview : final;
    if (next !== active) {
      active.pipeline.cancelOIDNDenoise?.();
      active = next;
      active.pipeline.begin();
      active.pipeline.activate();
    }
  }

  // Settings/scene uploads are shared where applicable. Target-local setters
  // still run on every target, including those that are currently inactive.
  const broadcast = (method: keyof TargetPipeline, args: unknown[]) => {
    savedSettings.set(method, args);
    let changed = false;
    for (const target of targets) {
      target.pipeline.activate();
      const fn = target.pipeline[method] as (...args: unknown[]) => unknown;
      changed = fn?.apply(target.pipeline, args) === true || changed;
    }
    const accumulationChanged = changed && [
      'setBouncesAndClamping', 'setDirectLightCandidates', 'setAlphaBlendStrategy',
      'setBevelSamples', 'setSamplingPattern', 'setTransmissiveOutputAlphaMin'
    ].includes(method);
    if (accumulationChanged || (changed && ['setMeshes', 'setTextureAtlasBudget'].includes(method)) ||
        method === 'setLights' || method === 'setBackground') {
      inputRevision++;
      for (const target of targets) {
        target.inputRevision = inputRevision;
        if (accumulationChanged) target.settingsRevision++;
        target.pipeline.invalidate();
      }
    }
    active.pipeline.activate();
    if (method === 'setSize') present(active);
    return changed;
  };
  function drawTarget(target: InternalAccumulationTarget, camera: Camera, sampleTarget: number, timeBudgetMs?: number) {
    if (!targets.includes(target)) throw new Error('Accumulation target belongs to another pipeline.');
    target.pipeline.activate();
    if (target.accumulatedRevision !== target.inputRevision) {
      target.pipeline.invalidate();
      target.accumulatedRevision = target.inputRevision;
    }
    if (timeBudgetMs !== undefined) target.pipeline.setMaxTimePerTile(timeBudgetMs);
    return target.pipeline.draw(camera, sampleTarget);
  }
  const pipeline = {
    finalTarget: final,
    previewTarget: preview,
    createTarget,
    drawTarget(target: InternalAccumulationTarget, camera: Camera, options: { sampleTarget: number; timeBudgetMs: number }) {
      return drawTarget(target, camera, options.sampleTarget, options.timeBudgetMs);
    },
    canCompleteSampleWithin(target: InternalAccumulationTarget, timeBudgetMs: number) {
      return target.pipeline.canCompleteSampleWithin(timeBudgetMs);
    },
    present,
    isFirstFrame: () => active.pipeline.isFirstFrame(),
    getTotalSamplesRendered: () => active.pipeline.getTotalSamplesRendered(),
    isPreviewMode: () => scheduler.preview,
    needsRestartSample(camera: Camera, sceneChanged = false) {
      const cameraEdited = cameraChanged(camera);
      const changed = scheduler.update(cameraEdited, sceneChanged, performance.now());
      if (changed) {
        if (cameraEdited) inputRevision++;
        for (const target of targets) { target.inputRevision = inputRevision; target.pipeline.invalidate(); }
        select();
      }
      return changed;
    },
    restartSamples() {
      active.pipeline.activate();
      active.pipeline.restartSamples();
    },
    draw(camera: Camera, sampleTarget: number) {
      const compiling = drawTarget(active, camera, sampleTarget);
      // A hidden probe or unfinished tile must retain the last complete image.
      if (!compiling) present(active);
      return compiling;
    },
    drawPostProcess() {
      active.pipeline.activate();
      active.pipeline.drawPostProcess();
      present(active);
    },
    setOnSampleRendered(cb: typeof callback) { callback = cb; },
    setPreviewParams(params: Parameters<RenderingPipeline['setPreviewParams']>[0]) {
      scheduler.configure(params.enabled, params.idleDelayMs);
      broadcast('setPreviewParams', [params]);
      select();
    },
    setOIDNPreviewActive(value: boolean) {
      denoisePreview = value;
      broadcast('setOIDNPreviewActive', [value]);
    },
    async performOIDNDenoise(...args: Parameters<NonNullable<RenderingPipeline['performOIDNDenoise']>>) {
      const target = active;
      target.pipeline.activate();
      const completed = await target.pipeline.performOIDNDenoise!(...args);
      if (completed && target === active) present(target);
      return completed;
    },
    cancelOIDNDenoise() { for (const target of targets) target.pipeline.cancelOIDNDenoise?.(); },
    setPreserveOIDNOutput(value: boolean) { active.pipeline.setPreserveOIDNOutput?.(value); },
    getDiagnostics() {
      return {
        ...active.pipeline.getDiagnostics(),
        presentedTarget: presented?.label,
        presentedComplete: presented?.pipeline.presentationComplete ?? false,
        targets: targets.map(target => ({ label: target.label, ...target.pipeline.getMemory() }))
      };
    },
    flushDiagnostics: async () => { await Promise.all(targets.map(target => target.pipeline.flushDiagnostics())); },
    readOutput: (kind: Parameters<RenderingPipeline['readOutput']>[0]) => active.pipeline.readOutput(kind),
    readDepthSamples: (area: Parameters<RenderingPipeline['readDepthSamples']>[0]) => {
      active.pipeline.activate(); return active.pipeline.readDepthSamples(area);
    },
    getDebugBVHData: () => active.pipeline.getDebugBVHData(),
    prepareOfflineAdaptiveSampling: (options: Parameters<RenderingPipeline['prepareOfflineAdaptiveSampling']>[0]) => {
      active.pipeline.activate(); return active.pipeline.prepareOfflineAdaptiveSampling(options);
    },
    dispose() {
      for (const target of targets) target.pipeline.dispose();
      disposeScene();
    }
  };
  const methods = [
    'setMeshes', 'setTextureAtlasBudget', 'setLights', 'setBackground',
    'setAllowsMultipleSamplesPerFrame', 'setOfflineRenderOptions', 'setVarianceMoments',
    'setAdaptiveSamplingTargets', 'setHDROutputEnabled', 'setToneMappingParams', 'setSize',
    'setBouncesAndClamping', 'setDirectLightCandidates', 'setAlphaBlendStrategy',
    'setBevelSamples', 'setSamplingPattern', 'setShadowCatcherParams', 'setBloomParams',
    'setMaxTimePerTile', 'setMaxTiles', 'setPreviewTargetFrameMs',
    'setTransmissiveOutputAlphaMin', 'setOutput'
  ] as const;
  for (const method of methods) {
    Object.assign(pipeline, { [method]: (...args: unknown[]) => broadcast(method, args) });
  }
  return pipeline as unknown as ResidentRenderingPipeline;
}
