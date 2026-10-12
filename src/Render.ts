import { Events } from './util/events.js';
import type Engine from './Engine.js';
import type Camera from './scene/Camera.js';
import { cameraSnapshot } from './renderer/cameraSnapshot.js';
import type { AlphaBlendStrategy } from './renderer/RenderingPipeline.js';
import { normalizeBevelSamples, normalizeDirectLightCandidates } from './renderer/RenderingPipeline.js';
import type { SamplingPattern } from './renderer/sampling.js';
import type { RenderTarget, TraceSettings } from './renderer/renderPipeline.js';
import type { OIDNDenoiser, OIDNModel } from './oidn.js';
import { createJNLMDenoiser, isJNLMDenoiser, type JNLMDenoiser, type JNLMOptions } from './renderer/jnlm.js';
import type { OfflineAdaptiveSamplingOptions, OfflineVarianceHistory } from './renderer/OfflineAdaptiveSampling.js';
import { nextPreviewScale } from './renderer/util.js';

/** Complete-sample notification, including the backend's measured sample time. */
export interface SampleEvent { samples: number; isFirstFrame: boolean; frameTimeMs: number; }
/** State of one independent accumulation. Default preparing. */
export type RenderStatus = 'preparing' | 'compiling' | 'converging' | 'denoising' | 'finished' | 'error';
/** Built-in filter implementation. Default jnlm, or oidn when model/weightsBaseUrl is given. */
export type DenoiserType = 'jnlm' | 'oidn';
/** Denoising configuration of one render. Assign null to disable. */
export interface DenoiserOptions extends JNLMOptions {
  /** Filter implementation. Default jnlm, or oidn when model/weightsBaseUrl is supplied. */ type?: DenoiserType;
  /** OIDN network. Default standard. */ model?: OIDNModel;
  /** Weight directory override. Default bundled standard/small assets and CDN large weights. */ weightsBaseUrl?: string | URL;
  /** Denoise at convergence, doubling sample batches, or every complete sample. Default converged. */ schedule?: 'converged' | 'progressive' | 'every-sample';
  /** Maximum OIDN tile size. Default chosen by oidn-web. */ maxTileSize?: number;
  /** Abort weight downloads. Default undefined. */ signal?: AbortSignal;
}
/** Optional per-render execution and image-quality settings. */
export interface RenderSettings {
  /** Maximum complete samples. Default 2048. */ maxSamples?: number;
  /** Maximum path depth. Default 3. */ bounces?: number;
  /** Radiance clamp; 0 disables it. Default 0. */ clamping?: number;
  /** Sampling sequence. Default sobol. */ samplingPattern?: SamplingPattern;
  /** Light candidates per vertex; WebGPU only, ignored on WebGL. Default 4. */ directLightCandidates?: number;
  /** Rounded material edges. Default true. */ bevel?: boolean;
  /** Bevel neighborhood probes, clamped to 1–32. Default 8. */ bevelSamples?: number;
  /** Wavelengths per dispersion sample. Default 3; 1 selects one random wavelength. */ dispersionWavelengths?: 1 | 3;
  /** Primary-ray alpha blend strategy; WebGPU only. Default stochastic. */ alphaBlendStrategy?: AlphaBlendStrategy;
  /** Minimum transmissive path alpha, using path depth. Default 1. Changes restart this accumulation. */ transmissiveOutputAlphaMin?: number;
  /** Tile execution budget in milliseconds. Default 21. */ timeBudgetMs?: number;
  /** Maximum tiles per frame. Default Infinity. */ maxTiles?: number;
  /** Accumulate multiple samples when frame time permits. Default false. */ allowMultipleSamplesPerFrame?: boolean;
  /** Adapt scale to frame timing; minScale must not exceed resolutionScale. Default false. */ adaptiveResolution?: {targetFrameMs: number; minScale: number} | false;
  /** Single-level fallback on the same engine. Default null. */ fallback?: Render | null;
  /** Denoising configuration. Default null. */ denoiser?: DenoiserOptions | null;
}
/** Constructor options: fixed dimensions and canvas-relative scale are mutually exclusive. */
export type RenderOptions = RenderSettings & (
  | { /** Fixed width in pixels, paired with height. */ width: number; /** Fixed height in pixels, paired with width. */ height: number; resolutionScale?: never }
  | { /** Canvas-relative resolution scale. Default 1. */ resolutionScale?: number; width?: never; height?: never }
);
/** Deterministic offline execution options. */
export interface ConvergeOptions {
  /** Final complete-sample budget. Required. */ samples: number;
  /** Camera override for this output only, copied on entry. Default committed engine camera. */ camera?: Camera;
  /** Two-stage variance sampling; WebGPU only, ignored on WebGL. Default undefined. */ adaptiveSampling?: Omit<OfflineAdaptiveSamplingOptions, 'maxSamples'>;
  /** Deterministic sequence base. Default 0. */ sampleSequenceOffset?: number;
  /** Maximum samples per submission batch. Default 8. */ samplesPerBatch?: number;
  /** WebGPU target batch completion time in milliseconds. Default undefined (fixed batch size). */ targetBatchTimeMs?: number;
  /** Delay between intermediate resolved images in milliseconds. Default undefined (resolve only at the end). */ previewIntervalMs?: number;
  /** Batch progress callback. Default undefined. */ onProgress?: (progress: {stage: 'pilot' | 'final' | 'denoising'; samples: number; targetSamples: number}) => void;
  /** Cancels the task. Default undefined. */ signal?: AbortSignal;
  /** Timeout per stage in milliseconds. Default 600000. */ timeoutMs?: number;
}
/** Result of deterministic offline convergence. */
export interface ConvergeResult {
  samples: number; averageSamplesPerPixel: number; pilotSamples: number;
  varianceHistory?: OfflineVarianceHistory; adaptiveSampling: boolean;
}

let oidnModule: Promise<typeof import('./oidn.js')> | undefined;
const loadOIDN = () => oidnModule ??= import('./oidn.js');

/** One independently configured image and its accumulation, owned by an engine. */
export default class Render {
  /** Maximum complete samples. Default 2048. */ maxSamples = 2048;
  /** Maximum path depth. Default 3. */ bounces = 3;
  /** Per-sample radiance clamp; 0 disables it. Default 0. */ clamping = 0;
  /** Sampling sequence. Default sobol. */ samplingPattern: SamplingPattern = 'sobol';
  /** WebGPU light candidates per vertex; ignored on WebGL. Default 4. */ directLightCandidates = 4;
  /** Rounded material edges. Default true. */ bevel = true;
  /** Bevel probes, clamped to 1–32. Default 8. */ bevelSamples = 8;
  /** Dispersion wavelengths per sample. Default 3. */ dispersionWavelengths: 1 | 3 = 3;
  /** WebGPU primary-ray alpha policy; ignored on WebGL. Default stochastic. */ alphaBlendStrategy: AlphaBlendStrategy = 'stochastic';
  /** Minimum transmissive path alpha. Default 1. Changing it restarts this render. */ transmissiveOutputAlphaMin = 1;
  /** Execution budget in milliseconds. Default 21. */ timeBudgetMs = 21;
  /** Maximum tiles per frame. Default Infinity. */ maxTiles = Infinity;
  /** Allow several samples per frame when possible. Default false. */ allowMultipleSamplesPerFrame = false;
  /** Adaptive resolution controller, or false. Default false. */ adaptiveResolution: {targetFrameMs: number; minScale: number} | false = false;
  private _resolutionScale = 1;
  /** Canvas-relative scale. Default 1; cannot be assigned on a fixed-size render. */
  get resolutionScale() { return this._resolutionScale; }
  set resolutionScale(value: number) {
    if (this._fixed) throw new Error('Fixed-size renders cannot use resolutionScale.');
    if (!Number.isFinite(value) || value <= 0) throw new Error('resolutionScale must be positive.');
    this._resolutionScale = value;
  }
  private _fallback: Render | null = null;
  /** Single-level fallback on this engine. Default null; chains and cycles are rejected. */
  get fallback() { return this._fallback; }
  set fallback(value: Render | null) {
    if (value && (value._engine !== this._engine || value === this || value.fallback)) throw new Error('Fallback must be a render on the same engine with no fallback.');
    if (value && this._dependents.size) throw new Error('Fallback renders cannot have their own fallback.');
    this._fallback?._dependents.delete(this);
    this._fallback = value; value?._dependents.add(this);
  }
  private _dependents = new Set<Render>();
  private _denoiserOptions: DenoiserOptions | null = null;
  /** Filter and schedule for this render. Default null. Loading is asynchronous and reported through status/errors. */
  get denoiser() { return this._denoiserOptions; }
  set denoiser(options: DenoiserOptions | null) {
    this._denoiserOptions = options ? { ...options } : null;
    this._refreshDenoiser();
  }
  private _fixed?: {width: number; height: number};
  private _target?: RenderTarget;
  private _status: RenderStatus = 'preparing';
  private _disposed = false;
  private _busy = false;
  private _offlineCamera = false;
  private _input = {scene: -1, camera: -1, settings: ''};
  private _adaptiveScale = 1;
  private _lastScale = 1;
  private _frameTime = 0;
  private _events = new Events<{sample: SampleEvent}>();
  /** Owning engine. */ get engine(): Engine { return this._engine; }
  /** Whether inference is queued or running, including intermediate updates. Default false. */ get denoising(): boolean { return !!this._denoisePending; }
  /** Subscribes to every complete sample on this render; returns unsubscribe. */
  on(event: 'sample', listener: (value: SampleEvent) => void): () => void { return this._events.on(event, listener); }
  private _filter?: OIDNDenoiser | JNLMDenoiser;
  private _filterKey = '';
  private _filterRevision = 0;
  private _filterPending?: Promise<void>;
  private _denoiseRevision = 0;
  private _denoisePending?: Promise<void>;
  private _denoisedSamples = 0;
  private _lastDenoiseTime = 0;
  private _warnedDenoisedReadback = false;
  /** @internal */ readonly _engine: Engine;

  constructor(engine: Engine, options: RenderOptions = {}) {
    this._engine = engine;
    if ('width' in options || 'height' in options) {
      if ('resolutionScale' in options || !Number.isInteger(options.width) || !Number.isInteger(options.height) || options.width! < 1 || options.height! < 1) throw new Error('Provide positive integer width and height, or resolutionScale, exclusively.');
      this._fixed = {width: options.width!, height: options.height!};
    }
    const {width: _width, height: _height, resolutionScale, fallback, denoiser, ...settings} = options;
    Object.assign(this, settings);
    if (resolutionScale !== undefined) this.resolutionScale = resolutionScale;
    this._adaptiveScale = this._resolutionScale; this._lastScale = this._resolutionScale;
    this._validate(); this.fallback = fallback ?? null;
    engine._register(this);
    if (denoiser) this.denoiser = denoiser;
  }
  /** Actual target width; before allocation uses the requested dimensions. */ get width() { return this._target?.getMemory().width || this._size().width; }
  /** Actual target height; before allocation uses the requested dimensions. */ get height() { return this._target?.getMemory().height || this._size().height; }
  /** Complete samples since the last restart; stale engine inputs report 0. Default 0. */
  get samples() { return this._current ? this._target?.getTotalSamplesRendered() ?? 0 : 0; }
  /** Whether complete samples reached maxSamples. Default false. */ get converged() { return this.samples >= this.maxSamples; }
  /** Current execution state. Default preparing. */ get status(): RenderStatus {
    if (!this._current && this._status !== 'error') return this._engine._ready ? 'converging' : 'preparing';
    return this._status;
  }
  private get _current() { const inputs = this._engine._inputs; return inputs.scene === this._input.scene && inputs.camera === this._input.camera && !this._disposed; }
  /** @internal */ get _complete() { return this._current && !!this._target?.presentationComplete && !this._target.isFirstFrame() && this.samples > 0; }
  /** @internal */ get _output() { if (this._disposed) throw new Error('Render is disposed.'); return this._target; }
  private _validate() {
    if (!Number.isFinite(this.maxSamples) || this.maxSamples < 1) throw new Error('maxSamples must be positive.');
    if (this.dispersionWavelengths !== 1 && this.dispersionWavelengths !== 3) throw new Error('dispersionWavelengths must be 1 or 3.');
    const adaptive = this.adaptiveResolution;
    if (adaptive && (this._fixed || !Number.isFinite(adaptive.targetFrameMs) || adaptive.targetFrameMs <= 0 || !Number.isFinite(adaptive.minScale) || adaptive.minScale <= 0 || adaptive.minScale > this._resolutionScale)) throw new Error('adaptiveResolution requires a scale-based render with positive targetFrameMs and minScale <= resolutionScale.');
  }
  private _size() {
    if (this._fixed) return this._fixed;
    const scale = this.adaptiveResolution ? Math.min(this._adaptiveScale, this._resolutionScale) : this._resolutionScale;
    return {width: Math.max(1, Math.round(this._engine.display.canvas.width * scale)), height: Math.max(1, Math.round(this._engine.display.canvas.height * scale))};
  }
  private _settings(sampleCap = this.maxSamples): TraceSettings {
    return {bounces: this.bounces, clamping: this.clamping, bevel: this.bevel, bevelSamples: normalizeBevelSamples(this.bevelSamples), dispersionWavelengths: this.dispersionWavelengths, directLightCandidates: normalizeDirectLightCandidates(this.directLightCandidates), alphaBlendStrategy: this.alphaBlendStrategy, transmissiveOutputAlphaMin: this.transmissiveOutputAlphaMin, samplingPattern: this.samplingPattern, maxSamples: sampleCap, timeBudgetMs: this.timeBudgetMs, maxTiles: this.maxTiles, allowMultipleSamplesPerFrame: this.allowMultipleSamplesPerFrame};
  }
  private _synchronize(sampleCap = this.maxSamples, offline = false) {
    this._validate();
    if (this._lastScale !== this._resolutionScale) { this._adaptiveScale = this._resolutionScale; this._lastScale = this._resolutionScale; }
    const target = this._target ??= this._engine._createTarget();
    if (!target) return;
    const settings = this._settings(sampleCap), size = this._size();
    const {timeBudgetMs: _budget, maxTiles: _tiles, allowMultipleSamplesPerFrame: _multiple, maxSamples, ...imageSettings} = settings;
    const key = JSON.stringify({ ...imageSettings, samples: this.samplingPattern === 'zsobol' ? maxSamples : undefined, ...size });
    const inputs = this._engine._inputs;
    target.configure(settings); target.activate();
    if ((!offline && this._offlineCamera) || inputs.scene !== this._input.scene || inputs.camera !== this._input.camera || key !== this._input.settings) {
      if (!offline) this._offlineCamera = false;
      this._cancelDenoise(); target.restartSamples();
      target.setSize(size.width, size.height);
      this._input = {scene: inputs.scene, camera: inputs.camera, settings: key};
    }
    target.setOnSampleRendered((samples, isFirstFrame, frameTimeMs) => { this._frameTime = frameTimeMs; this._events.emit('sample', {samples, isFirstFrame, frameTimeMs}); });
    return target;
  }
  /** Accumulates within this frame's budget. Rejects calls during converge or after disposal. */
  refine(): RenderStatus {
    if (this._busy) throw new Error('Cannot refine a render while converge is running.');
    if (this._disposed) throw new Error('Render is disposed.');
    this._engine._setRenderError();
    try { return this._refine(); }
    catch (error) { this._engine._setRenderError(this._engine._notifyError(error)); return this._status = 'error'; }
    finally { this._engine._reportShaderProgress(); }
  }
  private _refine(): RenderStatus {
    if (this._engine._initializationError) throw this._engine._initializationError;
    this._refreshDenoiser();
    if (!this._engine._ready) { void this._engine.init().catch(error => { if (!this._disposed) this._status = 'error'; this._engine._notifyError(error); }); return this._status = 'preparing'; }
    const target = this._synchronize();
    if (!target) return this._status = 'preparing';
    if (this._fallback && this.samples === 0 && !target.canCompleteSampleWithin(this.timeBudgetMs) && !this._fallback._complete) this._fallback._refineOne();
    target.activate();
    if (this._denoisePending) return this._status = this.converged ? 'denoising' : 'converging';
    target.setPreserveOIDNOutput?.(!!this._filter && this._schedule() === 'progressive');
    const limit = this._nextSampleTarget();
    if (this.samples < limit) {
      if (target.trace(this._engine._inputs.value!, limit)) return this._status = 'compiling';
    }
    this._maybeDenoise(false, limit);
    if (this._denoisePending) return this._status = this.converged ? 'denoising' : 'converging';
    if (this._filterPending && this.converged) return this._status = 'preparing';
    if (this.adaptiveResolution && this._frameTime > 0 && this.samples > 0) this._adaptiveScale = nextPreviewScale(this._adaptiveScale, this._frameTime, this.adaptiveResolution.targetFrameMs, this._resolutionScale, this.adaptiveResolution.minScale);
    return this._status = this.converged ? 'finished' : 'converging';
  }
  private _refineOne() {
    if (this._busy || this._disposed || !this._engine._ready) return;
    this._refreshDenoiser(); const target = this._synchronize();
    if (!target) return;
    target.activate();
    if (this.samples < 1) this._status = target.trace(this._engine._inputs.value!, 1) ? 'compiling' : 'converging';
    this._maybeDenoise();
  }
  private _schedule() { return this._denoiserOptions?.schedule ?? 'converged'; }
  private _nextSampleTarget() {
    if (!this._filter) return this.maxSamples;
    if (this._schedule() === 'every-sample') return Math.min(this.maxSamples, this.samples + 1);
    if (this._schedule() === 'converged') return this.maxSamples;
    if (this._denoisedSamples === 0) return 1;
    if (performance.now() - this._lastDenoiseTime >= 10000) return Math.min(this.maxSamples, this.samples + 1);
    return Math.min(this.maxSamples, Math.max(4, this._denoisedSamples * 2));
  }
  private _refreshDenoiser() {
    if (this._disposed) return;
    const options = this._denoiserOptions;
    const key = options ? JSON.stringify({...options, schedule: undefined, signal: undefined, weightsBaseUrl: options.weightsBaseUrl?.toString()}) : '';
    if (key === this._filterKey) return;
    this._filterKey = key; const revision = ++this._filterRevision;
    this._cancelDenoise();
    if (this._filter) this._engine._releaseDenoiser(this._filter);
    this._target?.invalidateDenoisedOutput();
    this._filter = undefined; this._filterPending = undefined;
    if (!options) return;
    const type = options.type ?? (options.model || options.weightsBaseUrl ? 'oidn' : 'jnlm');
    if (type === 'jnlm') { this._filter = this._engine._retainDenoiser(`jnlm:${key}`, () => createJNLMDenoiser(options)); return; }
    const task = (async () => {
      await this._engine.init();
      if (this._engine.backend !== 'webgpu') { if (revision === this._filterRevision) console.warn('OIDN requires WebGPU; denoising is disabled for this render.'); return; }
      const {initializeOIDN} = await loadOIDN();
      const cacheKey = JSON.stringify({type: 'oidn', model: options.model ?? 'standard', weightsBaseUrl: options.weightsBaseUrl?.toString(), maxTileSize: options.maxTileSize});
      const filter = await this._engine._acquireDenoiser(cacheKey, () => initializeOIDN(this._engine, {model: options.model, weightsBaseUrl: options.weightsBaseUrl, maxTileSize: options.maxTileSize, signal: options.signal}));
      if (revision !== this._filterRevision || this._disposed) { this._engine._releaseDenoiser(filter); return; }
      this._filter = filter; this._warmDenoiser();
    })();
    this._filterPending = task;
    void task.catch(error => { if (revision === this._filterRevision && !this._disposed) this._engine._notifyError(error); }).finally(() => { if (this._filterPending === task) this._filterPending = undefined; });
  }
  private _warmDenoiser() {
    const filter = this._filter, revision = this._filterRevision;
    if (!filter || isJNLMDenoiser(filter)) return;
    const filters = [filter, filter.auxiliaryDenoisers?.albedo, filter.auxiliaryDenoisers?.normal];
    const width = this.width, height = this.height;
    const task = this._engine._enqueueDenoise(async () => {
      if (revision !== this._filterRevision || filter !== this._filter || this._disposed) return;
      await Promise.all(filters.map(network => network?.prepareForImage?.(width, height, {tileOverlap: this._schedule() === 'converged' ? undefined : 80})));
    });
    void task.catch(error => {
      if (revision === this._filterRevision && filter === this._filter && !this._disposed) this._engine._notifyError(error);
    });
  }

  private _cancelDenoise() { this._denoiseRevision++; this._target?.cancelOIDNDenoise?.(); this._denoisePending = undefined; this._denoisedSamples = 0; }
  /** @internal */ _inputsChanged(resetTiming = false) { this._cancelDenoise(); if (resetTiming) this._target?.invalidateTiming?.(); }
  /** @internal */ _displayChanged() { this._cancelDenoise(); this._target?.invalidateDenoisedOutput(); }
  private _maybeDenoise(force = false, sampleTarget = this._nextSampleTarget()) {
    const target = this._target, filter = this._filter;
    if (!target || !filter || this._denoisePending || this.samples < 1 || this._denoisedSamples === this.samples) return;
    if (!force && this._schedule() === 'converged' && !this.converged) return;
    if (!force && this._schedule() === 'progressive' && this.samples < sampleTarget) return;
    this._engine.display._configure(this);
    target.activate(); target.drawPostProcess();
    const revision = ++this._denoiseRevision, samples = this.samples;
    // One shared scratch lease across all renders; queued stale jobs do no GPU work.
    const task = this._engine._enqueueDenoise(async () => {
      if (revision !== this._denoiseRevision || this._disposed) return;
      target.activate(); this._engine.display._configure(this);
      if (revision !== this._denoiseRevision || this._disposed) return;
      target.drawPostProcess();
      const complete = await target.performOIDNDenoise?.(filter, undefined, this._schedule());
      if (revision !== this._denoiseRevision || this._disposed) return;
      if (complete) { target.activate(); target.drawPostProcess(); this._denoisedSamples = samples; this._lastDenoiseTime = performance.now(); }
    });
    this._denoisePending = task;
    void task.catch(error => { if (revision === this._denoiseRevision && !this._disposed) this._engine._notifyError(error); }).finally(() => { if (this._denoisePending === task) { this._denoisePending = undefined; this._status = this.converged ? 'finished' : 'converging'; } });
  }
  /** Reads this target's native RGBA float32 output, top row first. Default hdr; unavailable denoised output falls back to hdr. */
  async readPixels(kind: 'hdr' | 'denoised' | 'albedo' | 'normal' = 'hdr') {
    if (this._disposed) throw new Error('Render is disposed.');
    const target = this._target;
    if (!target) return {width: 0, height: 0, data: new Float32Array(0)};
    if (kind === 'denoised' && this._denoisedSamples === 0) {
      if (!this._warnedDenoisedReadback) { this._warnedDenoisedReadback = true; console.warn('Denoised output is not ready; reading HDR samples instead.'); }
      kind = 'hdr';
    }
    target.activate(); return target.readOutput(kind);
  }
  /** Discards only this render's accumulation and pending denoising. */
  restart() { if (this._disposed) throw new Error('Render is disposed.'); this._cancelDenoise(); this._target?.restartSamples(); this._status = 'converging'; }
  /** Releases only this render's image resources and denoiser. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true; this._events.clear(); this._filterRevision++; this._cancelDenoise();
    if (this._target) this._engine._releaseTarget(this._target);
    if (this._filter) this._engine._releaseDenoiser(this._filter);
    this._target = undefined; this._filter = undefined; this._engine._unregister(this);
    this._fallback?._dependents.delete(this);
    for (const dependent of this._dependents) dependent._fallback = null;
    this._dependents.clear();
  }
  /** Deterministically renders this image. Rejects on abort/timeout/input revision changes and blocks refine on this render. */
  async converge(options: ConvergeOptions): Promise<ConvergeResult> {
    if (this._busy) throw new Error('Converge is already running on this render.');
    if (this._disposed) throw new Error('Render is disposed.');
    const inputs = this._engine._inputs;
    if (!inputs.value) throw new Error('Commit engine.scene and engine.camera with engine.update() before converge.');
    const camera = cameraSnapshot(options.camera ?? inputs.value);
    const samples = Math.max(1, Math.round(options.samples));
    if (!Number.isFinite(samples)) throw new Error('samples must be finite and positive.');
    const batchLimit = Math.max(1, Math.round(options.samplesPerBatch ?? 8));
    const sequenceOffset = Math.max(0, Math.round(options.sampleSequenceOffset ?? 0));
    const timeout = Math.max(1, options.timeoutMs ?? 600000);
    const check = () => {
      if (this._disposed) throw new Error('Render is disposed.');
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Convergence aborted', 'AbortError');
      const current = this._engine._inputs;
      if (current.scene !== inputs.scene || current.camera !== inputs.camera) throw new Error('Engine inputs changed during converge.');
    };
    this._busy = true;
    let target: RenderTarget | undefined;
    const start = performance.now();
    try {
      await this._engine.init();
      while (!this._engine._ready) { check(); if (performance.now() - start > timeout) throw new Error('Timed out preparing convergence.'); await new Promise(resolve => setTimeout(resolve, 0)); }
      target = this._synchronize(samples, true);
      this._offlineCamera = !!options.camera;
      if (!target) throw new Error('The render target is not ready.');
      this._cancelDenoise(); target.restartSamples();
      this._refreshDenoiser(); await this._filterPending;
      const stage = async (cap: number, name: 'pilot' | 'final', offset: number) => {
        check(); this._cancelDenoise(); target!.activate(); target!.restartSamples();
        target!.configure({...this._settings(cap), allowMultipleSamplesPerFrame: true});
        let batch = options.targetBatchTimeMs && this._engine.device ? 1 : Math.min(batchLimit, cap);
        let previous = -1, lastPreview = performance.now(); const started = performance.now();
        for (;;) {
          check(); if (performance.now() - started > timeout) throw new Error(`Timed out rendering the offline ${name} pass.`);
          target!.activate(); target!.setOfflineRenderOptions({samplesPerBatch: batch, deferPostProcess: true, sampleSequenceOffset: offset});
          const before = target!.getTotalSamplesRendered(), batchStarted = performance.now();
          this._status = target!.trace(camera, cap) ? 'compiling' : 'converging';
          const count = target!.getTotalSamplesRendered();
          if (count !== previous) {
            previous = count; options.onProgress?.({stage: name, samples: Math.min(count, cap), targetSamples: cap});
            if (name === 'final' && options.previewIntervalMs !== undefined && count > 0 && count < cap && performance.now() - lastPreview >= options.previewIntervalMs) { target!.drawPostProcess(); lastPreview = performance.now(); }
          }
          if (count >= cap) break;
          if (count > before && this._engine.device) await this._engine.device.queue.onSubmittedWorkDone();
          else await new Promise(resolve => setTimeout(resolve, 0));
          if (options.targetBatchTimeMs && this._engine.device && count > before) {
            const desired = Math.max(1, Math.min(batchLimit, Math.round(options.targetBatchTimeMs * (count - before) / Math.max(1, performance.now() - batchStarted))));
            batch = desired > batch ? Math.min(desired, batch * 2) : desired;
          }
        }
        await this._engine.device?.queue.onSubmittedWorkDone(); check();
      };
      let result: ConvergeResult = {samples, averageSamplesPerPixel: samples, pilotSamples: 0, adaptiveSampling: false};
      if (options.adaptiveSampling && this._engine.device) {
        const pilotSamples = Math.min(samples, Math.max(2, Math.round(options.adaptiveSampling.pilotSamples ?? 8)));
        target.activate(); target.setVarianceMoments(true); target.setAdaptiveSamplingTargets(undefined);
        await stage(pilotSamples, 'pilot', sequenceOffset);
        target.activate(); const plan = await target.prepareOfflineAdaptiveSampling({...options.adaptiveSampling, maxSamples: samples});
        if (plan) {
          target.activate(); target.setVarianceMoments(false);
          await stage(plan.maximumTarget, 'final', sequenceOffset + pilotSamples);
          result = {samples: plan.maximumTarget, averageSamplesPerPixel: plan.averageTarget, pilotSamples, varianceHistory: plan.history, adaptiveSampling: true};
        } else { target.setVarianceMoments(false); target.setAdaptiveSamplingTargets(undefined); await stage(samples, 'final', sequenceOffset); }
      } else { target.activate(); target.setVarianceMoments(false); target.setAdaptiveSamplingTargets(undefined); await stage(samples, 'final', sequenceOffset); }
      if (this._filter) {
        options.onProgress?.({stage: 'denoising', samples: result.samples, targetSamples: result.samples});
        this._status = 'denoising'; this._maybeDenoise(true); await this._denoisePending; check();
      }
      this._status = 'finished'; return result;
    } catch (error) { this._status = 'error'; throw error; }
    finally {
      if (target && !this._disposed) { target.activate(); target.setVarianceMoments(false); target.setAdaptiveSamplingTargets(undefined); target.setOfflineRenderOptions({samplesPerBatch: 0, deferPostProcess: false, sampleSequenceOffset: 0}); }
      this._busy = false;
    }
  }
}
