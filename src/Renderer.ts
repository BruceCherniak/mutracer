import { ensureMeshGeometryAttributes } from './renderer/prepareMeshBVH';
import {
  DEFAULT_BEVEL_SAMPLES,
  DEFAULT_DIRECT_LIGHT_CANDIDATES,
  AlphaBlendStrategy,
  RenderOutput,
  RenderingDiagnostics,
  RenderingPipeline,
  ToneMapping,
  normalizeBevelSamples
} from './renderer/RenderingPipeline';
import makeWebGLRenderingPipeline from './renderer/WebGLRenderingPipeline';
import { Renderer as WebGLRenderer } from './renderer/webgl';
import Mesh from './scene/Mesh';
import { SceneChangeDetector } from './renderer/sceneChangeDetector';
import type Geometry from './scene/Geometry';
import Camera from './scene/Camera';
import { Scene } from './scene/Scene';
import { ColorRGB } from './types';
import type { OIDNDenoiser, OIDNModel } from './oidn';
import { precomputeTinyBvh } from './tinybvh/precomputeTinyBvh';
import { meshNeedsPrecompute } from './util/workerHelper';
import makeWGPURenderingPipeline, {
  OIDNWeb,
  WGPURenderingPipeline
} from './renderer/WGPURenderingPipeline';
import { DEFAULT_MAX_TEXTURE_ARRAY_BYTES } from './renderer/MergedMaterialData';
import {
  type OfflineAdaptiveSamplingOptions,
  type OfflineVarianceHistory
} from './renderer/OfflineAdaptiveSampling';
/** BLAS builder for meshes without a precomputed BVH. See {@link Renderer.bvhBuilder}. */
export type BVHBuilder = 'tinybvh' | 'builtin';

/** Options for {@link Renderer.setDenoiser}. */
export interface DenoiserOptions {
  /**
   * OIDN network. `standard` (default) balances quality and speed, `small`
   * is fastest, `cleanAuxLarge` prefilters the albedo/normal guides and gives
   * the cleanest result at the highest cost.
   */
  model?: OIDNModel;
  /**
   * Directory containing the `.tza` weights. Defaults to the jsDelivr copy
   * published with this package version; self-host for production.
   */
  weightsBaseUrl?: string | URL;
  /**
   * Denoise interactive frames and every `oidnRealtimeSampleInterval`
   * samples instead of only when `maxSamples` is reached. Default `false`.
   */
  realtime?: boolean;
  /** Maximum OIDN tile size. By default oidn-web chooses it. */
  maxTileSize?: number;
  /** Abort the weight download. */
  signal?: AbortSignal;
}

/** Constructor options for {@link Renderer}. */
export interface RendererParams {
  /** Canvas to render into. A new canvas is created when omitted. */
  canvas?: HTMLCanvasElement;
  /**
   * Use WebGPU when available and fall back to WebGL 2 otherwise. Set to
   * `false` to force the WebGL 2 backend. Default `true`.
   */
  preferWebGPU?: boolean;
  /**
   * Enable OIDN denoising (WebGPU only). `true` uses the default
   * {@link DenoiserOptions}. Equivalent to calling `setDenoiser()`.
   * Default `false`.
   */
  denoiser?: boolean | DenoiserOptions;
  /**
   * Samples between denoised updates when realtime denoising is enabled.
   * Default `8`.
   */
  oidnRealtimeSampleInterval?: number;
  /** WebGL 2 `preserveDrawingBuffer`, needed to read the canvas back. Default `true`. */
  preserveDrawingBuffer?: boolean;
}

/** Snapshot returned by {@link Renderer.getDiagnostics}. */
export interface RendererDiagnostics extends RenderingDiagnostics {
  /** GPU adapter description reported by the browser. */
  adapterName: string;
  backend: 'webgpu' | 'webgl';
  height: number;
  width: number;
  /** Runtime information reported by oidn-web, when a denoiser is attached. */
  oidn?: {
    beauty: unknown;
    albedo?: unknown;
    normal?: unknown;
  };
}

/** Device limits that bound the material texture atlas. */
export interface TextureAtlasLimits {
  maxTextureArrayLayers: number;
  maxTextureDimension2D: number;
}

/** Options for {@link Renderer.renderOfflineFrame}. */
export interface OfflineFrameRenderOptions {
  /** Fixed maximum spp, or the final-pass cap when adaptive sampling is used. */
  samples: number;
  /** Number of complete samples submitted before yielding to progress/UI work. */
  samplesPerBatch?: number;
  /**
   * Target GPU completion time for one batch. When set on WebGPU, each pass
   * starts with one sample and adapts up to `samplesPerBatch` from measured
   * queue completion time. This limits long GPU monopolization without adding
   * an artificial animation-frame wait.
   */
  targetBatchTimeMs?: number;
  /** Deterministic sequence base. Use a disjoint range for every animation frame. */
  sampleSequenceOffset?: number;
  /** Two-stage variance allocation. Unsupported WebGL backends fall back to fixed spp. */
  adaptiveSampling?: Omit<OfflineAdaptiveSamplingOptions, 'maxSamples'>;
  /**
   * Minimum delay between intermediate final-pass canvas updates. Omit to
   * defer all intermediate post-processing for maximum export throughput.
   */
  previewIntervalMs?: number;
  /** Called after each batch and while denoising. */
  onProgress?: (progress: {
    stage: 'pilot' | 'final' | 'denoising';
    samples: number;
    targetSamples: number;
  }) => void;
  /** Abort rendering; the returned promise rejects with the abort reason. */
  signal?: AbortSignal;
  /** Reject when a stage takes longer than this. Default 600000 (10 minutes). */
  timeoutMs?: number;
}

/** Result of {@link Renderer.renderOfflineFrame}. */
export interface OfflineFrameRenderResult {
  /** Largest final-pass target assigned to any pixel. */
  samples: number;
  /** Mean final-pass target across all pixels. Pilot work is excluded. */
  averageSamplesPerPixel: number;
  /** Independent pilot work used to choose the final-pass budgets. */
  pilotSamples: number;
  varianceHistory?: OfflineVarianceHistory;
  adaptiveSampling: boolean;
}



/** Not reported by `render()`; reserved as an initial value for callers. */
export const RENDER_STATUS_UNKNOWN = 0;
/** Shaders/pipelines are compiling. No new samples were added. */
export const RENDER_STATUS_COMPILING_SHADER = 1;
/** Samples were added; `maxSamples` has not been reached yet. */
export const RENDER_STATUS_RENDERING = 2;
/** `maxSamples` was reached and OIDN is denoising the result. */
export const RENDER_STATUS_DENOISING = 3;
/** The image is complete (and denoised, if a denoiser is set). */
export const RENDER_STATUS_FINISHED = 4;
/** Rendering failed. Details are logged and in `getDiagnostics()`. */
export const RENDER_STATUS_ERROR = 5;
/** The GPU device is initializing or BVHs are being built. */
export const RENDER_STATUS_PREPARING = 6;

/** Value returned by {@link Renderer.render}. */
export type RenderStatus =
  | typeof RENDER_STATUS_UNKNOWN
  | typeof RENDER_STATUS_COMPILING_SHADER
  | typeof RENDER_STATUS_RENDERING
  | typeof RENDER_STATUS_DENOISING
  | typeof RENDER_STATUS_FINISHED
  | typeof RENDER_STATUS_ERROR
  | typeof RENDER_STATUS_PREPARING;

const OIDN_DENOISING = 1;
const OIDN_DENOISED = 2;
export const DEFAULT_OIDN_REALTIME_SAMPLE_INTERVAL = 8;

function validateOidnRealtimeSampleInterval(value: number) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      'oidnRealtimeSampleInterval must be a positive integer'
    );
  }
  return value;
}

let oidnModule: Promise<typeof import('./oidn')> | undefined;
/** OIDN (and oidn-web) is only fetched when a denoiser is requested. */
function loadOIDNModule() {
  return (oidnModule ??= import('./oidn'));
}

function disposeOIDNDenoiser(denoiser?: OIDNDenoiser) {
  if (!denoiser) return;
  denoiser.auxiliaryDenoisers?.albedo.dispose();
  denoiser.auxiliaryDenoisers?.normal.dispose();
  denoiser.dispose();
}

let globalGPUDevice: GPUDevice | null = null;
let globalGPUAdapter: GPUAdapter | null = null;
let globalGPUAdapterInfo: GPUAdapterInfo | null = null;

/**
 * Progressive path tracer. Uses WebGPU when available and WebGL 2 otherwise.
 *
 * ```ts
 * const renderer = new Renderer({ canvas });
 * renderer.setSize(canvas.width, canvas.height);
 * function frame() {
 *   renderer.render(scene, camera);
 *   requestAnimationFrame(frame);
 * }
 * frame();
 * ```
 *
 * Settings are plain properties and are read on the next `render()` call.
 * Changing a setting that affects the image restarts accumulation.
 */
export default class Renderer {
  /** Maximum path depth (number of bounces). Default `3`. */
  bounces = 3;
  /**
   * Clamp each sample's radiance to reduce fireflies. `0` disables clamping
   * (unbiased). Default `0`.
   */
  clamping = 0;

  /** Samples per pixel to accumulate before the image is finished. Default `2048`. */
  maxSamples = 2048;

  /** Samples between denoised updates when realtime denoising is enabled. */
  readonly oidnRealtimeSampleInterval: number;

  private _bevelSamples = DEFAULT_BEVEL_SAMPLES;

  /**
   * Neighborhood probes per path sample for `OpenPBRMaterial.bevelSize`
   * (rounded edges). Clamped to 1–32. Default `8`.
   */
  get bevelSamples() {
    return this._bevelSamples;
  }

  set bevelSamples(samples: number) {
    this._bevelSamples = normalizeBevelSamples(samples);
  }

  /**
   * Target GPU time in milliseconds per submitted tile. Large frames are split
   * into tiles to keep the page responsive. Default `21`.
   */
  maxTimePerTile = 21;
  /** Target GPU time in milliseconds per interactive preview frame. Default `20`. */
  maxTimePreview = 20;

  /**
   * Light candidates resampled for each next-event estimate (WebGPU). More
   * candidates reduce noise in scenes with many lights at a higher cost per
   * sample. Interactive preview uses at most two. Clamped to 1–16. Default `4`.
   */
  directLightCandidates = DEFAULT_DIRECT_LIGHT_CANDIDATES;

  /**
   * Primary-ray handling of alpha-blended (glTF `BLEND`) materials on WebGPU.
   * `stochastic` treats alpha as coverage per sample; `deterministic-source-over`
   * splits the primary ray and blends both sides every sample. Default `stochastic`.
   */
  alphaBlendStrategy: AlphaBlendStrategy = 'stochastic';

  /**
   * Render a cheaper, lower-resolution image while the camera or scene is
   * changing, then resume full quality. Default `true`.
   */
  interactivePreview = true;
  /** Maximum resolution scale used by interactive preview (0.25–1). Default `0.5`. */
  previewResolutionScale = 0.5;
  /** Path depth used by interactive preview. Default `2`. */
  previewBounces = 2;
  /** Milliseconds without changes before full-quality rendering resumes. Default `150`. */
  previewIdleDelayMs = 150;

  /** Upper bound for the number of tiles per frame. Default `Infinity`. */
  maxTiles = Infinity;

  /**
   * BLAS builder used for meshes without a precomputed BVH. `tinybvh` builds
   * asynchronously in WebAssembly before the first frame (`render()` returns
   * `RENDER_STATUS_PREPARING` meanwhile) and falls back to `builtin`
   * (synchronous JavaScript) if the module cannot be loaded. Default `tinybvh`.
   */
  bvhBuilder: BVHBuilder = 'tinybvh';
  private _bvhPreparation?: Promise<void>;
  private _tinyBvhUnavailable = false;
  /** Geometry (and its version) each mesh had when TinyBVH last processed it. */
  private _bvhPreparedGeometry = new WeakMap<Mesh, [Geometry, number]>();

  /**
   * Memory budget in bytes for the packed material texture atlas. Larger
   * textures are downscaled to fit. Default 384 MiB.
   */
  textureAtlasBudgetBytes = DEFAULT_MAX_TEXTURE_ARRAY_BYTES;

  /** Canvas the renderer draws into. */
  readonly canvas: HTMLCanvasElement;

  /** Called whenever new samples were added to the image. */
  onSampleRendered?: (
    sampleCount: number,
    isFirstFrame: boolean,
    frameTime: number
  ) => void;

  /** Linear exposure multiplier applied before tone mapping. Default `1`. */
  toneMappingExposure = 1;
  /** Display transform. Default `agx`. */
  toneMapping: ToneMapping = 'agx';
  /**
   * Present extended-range (HDR) values on displays and browsers that support
   * WebGPU HDR canvases, without display-referred tone mapping. Default `false`.
   */
  hdrOutputEnabled = false;
  /** Adapt exposure from a GPU luminance histogram (WebGPU). Default `false`. */
  autoExposure = false;
  /** Color grading contrast multiplier. Default `1`. */
  contrast = 1;
  /** Color grading saturation multiplier. Default `1`. */
  saturation = 1;
  /** White-balance temperature shift, roughly -1 (cool) to 1 (warm). Default `0`. */
  temperature = 0;
  /** White-balance tint shift, roughly -1 (green) to 1 (magenta). Default `0`. */
  tint = 0;
  /** Vignette strength. Default `0`. */
  vignette = 0;

  /**
   * Allow several samples per `render()` call when the GPU has time to spare.
   * Default `false`.
   */
  allowMultipleSamplesPerFrame = false;
  /** Color of the shadows cast onto shadow-catcher materials. Default black. */
  shadowCatcherColor: ColorRGB = [0, 0, 0];
  /** Opacity multiplier of shadow-catcher shadows. Default `1`. */
  shadowCatcherAlpha = 1;

  /**
   * Minimum output alpha of transmissive surfaces when the background is
   * transparent. `1` renders glass as opaque. Default `1`.
   */
  transmissiveOutputAlphaMin = 1;

  /** Use a stratified low-discrepancy sample sequence instead of white noise. Default `true`. */
  useStratifiedSampling = true;

  /** Bloom intensity. `0` disables bloom. Default `0`. */
  bloomIntensity = 0;
  /** Luminance above which pixels contribute to bloom. Default `1`. */
  bloomThreshold = 1;
  /** Bloom radius (0–1). Default `0.6`. */
  bloomRadius = 0.6;

  private _oidn?: OIDNWeb;

  /**
   * Resolve camera changes as one-sample OIDN frames, then accumulate static
   * realtime frames in denoise-sized batches.
   *
   * While a denoise is running, camera-only changes are coalesced so the GPU
   * never accumulates a queue of obsolete OIDN work. Scene changes normally
   * invalidate immediately; animation playback may opt into latest-frame
   * coalescing with oidnRealtimeSceneUpdates.
   */
  private _oidnRealtime = false;
  /**
   * Coalesce continuous scene changes while realtime OIDN is running, then
   * render and denoise the latest scene state. Intended for animation playback.
   */
  oidnRealtimeSceneUpdates = false;
  private _oidnRealtimeSceneUpdatePending = false;
  /** Re-denoise the first settled frame after a camera gesture. */
  private _oidnRealtimeStaticDenoisePending = false;
  /** Hold the first sample target through compilation, tiling and OIDN. */
  private _oidnFirstFrameDenoisePending = false;

  /**
   * Denoise interactive frames and every `oidnRealtimeSampleInterval` samples
   * instead of only the finished image. Set by `setDenoiser({ realtime })`.
   */
  get oidnRealtime() {
    return this._oidnRealtime;
  }

  set oidnRealtime(enabled: boolean) {
    const next = !!enabled;
    if (this._oidnRealtime === next) return;
    this._oidnRealtime = next;
    this._oidnRealtimeStaticDenoisePending = false;
    this._oidnRealtimeSceneUpdatePending = false;
    this._oidnFirstFrameDenoisePending = next;
    this._prepareOIDNForCurrentSize();
    this._pipeline?.restartSamples();
    this._renderDone = false;
    this._oidnStatus = 0;
    this._oidnRevision++;
  }

  /**
   * The attached OIDN denoiser. Prefer {@link Renderer.setDenoiser}; assign
   * directly only for denoisers loaded with `claypt/oidn` helpers.
   */
  get oidn() {
    return this._oidn;
  }

  set oidn(denoiser: OIDNWeb | undefined) {
    if (this._oidn === denoiser) return;
    this._oidn = denoiser;
    this._oidnFirstFrameDenoisePending = this.oidnRealtime;
    // A newly selected network must run against the existing accumulation.
    this._oidnStatus = 0;
    this._oidnRevision++;
    this._prepareOIDNForCurrentSize();
  }

  private _prepareOIDNForCurrentSize() {
    const denoiser = this._oidn;
    if (!denoiser?.prepareForImage) return;
    if (this.canvas.width <= 0 || this.canvas.height <= 0) return;
    const options = { tileOverlap: this._oidnRealtime ? 80 : undefined };
    const filters = [
      denoiser,
      denoiser.auxiliaryDenoisers?.albedo,
      denoiser.auxiliaryDenoisers?.normal
    ];
    for (const filter of filters) {
      if (!filter?.prepareForImage) continue;
      void filter.prepareForImage(
        this.canvas.width,
        this.canvas.height,
        options
      ).catch((error) => {
        console.warn('Failed to prepare OIDN tile shapes.', error);
      });
    }
  }
  /**
   * Optional LDR denoiser applied to the composed image's alpha channel
   * (transparent backgrounds and shadow catchers).
   */
  oidnAlpha?: OIDNWeb;
  private _ownedDenoiser?: OIDNDenoiser;
  private _denoiserRevision = 0;

  /** Image shown on the canvas, e.g. `albedo` or `normal` for debugging. Default `final`. */
  output: RenderOutput = 'final';

  private _gpuDevice?: GPUDevice;
  private _gpuAdapter?: GPUAdapter | null;
  private _gpuAdapterInfo?: GPUAdapterInfo;

  private _preserveDrawingBuffer;
  private _preferWebGPU;
  private _pipelineInitError?: unknown;
  private _lastRenderError?: string;

  private _sceneChangeDetector = new SceneChangeDetector();
  private _scenePipeline: RenderingPipeline | undefined;
  private _sceneInitialized = false;
  private _forceMeshUpdate = false;
  // `undefined` is a valid "no background" scene value, so use `null` as the
  // uninitialized sentinel and force the pipeline to receive the initial
  // background state even when the scene starts without one.

  private _webglRenderer?: WebGLRenderer;
  private _pipeline?: RenderingPipeline;

  // Some status
  private _pipelineInitedPromise?: Promise<void>;
  private _pipelineInited?: () => void;

  private _initing = false;
  private _renderDone = false;
  private _oidnStatus = 0;
  private _oidnRevision = 0;

  constructor(params: RendererParams = {}) {
    this.oidnRealtimeSampleInterval = validateOidnRealtimeSampleInterval(
      params.oidnRealtimeSampleInterval ?? DEFAULT_OIDN_REALTIME_SAMPLE_INTERVAL
    );
    this.canvas = params.canvas || document.createElement('canvas');
    this._preserveDrawingBuffer = params.preserveDrawingBuffer ?? true;
    this._preferWebGPU = params.preferWebGPU ?? true;
    if (params.denoiser) {
      this.setDenoiser(params.denoiser).catch((error) => {
        console.warn('OIDN denoiser could not be enabled.', error);
      });
    }

    this._pipelineInitedPromise = new Promise((resolve) => {
      this._pipelineInited = resolve;
    });
  }

  /** Resizes the canvas drawing buffer and the render targets, in pixels. */
  setSize(width: number, height: number) {
    // Assigning either canvas dimension resets its drawing buffer even when
    // the value is unchanged. For WebGPU that also invalidates the current
    // presentation texture, which may still be referenced by a command buffer
    // while an asynchronous pipeline update is in flight.
    if (width === this.canvas.width && height === this.canvas.height) {
      return;
    }
    this.canvas.width = width;
    this.canvas.height = height;
    if (this._pipeline) {
      this._pipeline.setSize(width, height);
    }
    this._renderDone = false;
  }

  getSize() {
    return {
      width: this.canvas.width,
      height: this.canvas.height
    };
  }

  /** Samples per pixel accumulated so far, or `undefined` before initialization. */
  getTotalSamplesRendered() {
    if (this._pipeline) {
      return this._pipeline.getTotalSamplesRendered();
    }
  }

  /** Completes pending GPU timestamp readback used by diagnostics. */
  async flushDiagnostics() {
    await this._pipelineInitedPromise;
    await this._pipeline?.flushDiagnostics();
  }

  /**
   * Loads an OIDN denoiser on the renderer's WebGPU device and attaches it,
   * replacing (and disposing) the previous one. Pass `false` or `null` to
   * disable denoising. Rejects on WebGL or when the weights cannot be loaded.
   */
  async setDenoiser(options: DenoiserOptions | boolean | null = true) {
    const revision = ++this._denoiserRevision;
    const previous = this._ownedDenoiser;
    if (!options) {
      this._ownedDenoiser = undefined;
      if (previous && this.oidn === previous) this.oidn = undefined;
      this.oidnRealtime = false;
      disposeOIDNDenoiser(previous);
      return;
    }
    const { realtime = false, ...loadOptions } =
      options === true ? {} : options;
    const { initializeOIDN } = await loadOIDNModule();
    const denoiser = await initializeOIDN(this, {
      ...loadOptions,
      attach: false
    });
    if (revision !== this._denoiserRevision) {
      // A newer setDenoiser() call superseded this one.
      disposeOIDNDenoiser(denoiser);
      return;
    }
    this._ownedDenoiser = denoiser;
    this.oidnRealtime = realtime;
    this.oidn = denoiser;
    if (previous !== denoiser) disposeOIDNDenoiser(previous);
  }

  /**
   * Builds BVHs (and displacement tessellation) for every mesh that does not
   * have one yet. `render()` does this automatically and reports
   * `RENDER_STATUS_PREPARING` meanwhile; call this to prepare a scene up front.
   */
  async prepareScene(scene: Pick<Scene, 'meshes'> | Mesh[]) {
    const meshes = Array.isArray(scene) ? scene : scene.meshes;
    if (this.bvhBuilder !== 'tinybvh' || this._tinyBvhUnavailable) return;
    const pending = meshes.filter(mesh => !mesh.geometry.dynamic && meshNeedsPrecompute(mesh));
    if (!pending.length) return;
    try {
      await precomputeTinyBvh(pending, 'bvh2', undefined, { onlyMissing: true });
    } catch (error) {
      this._tinyBvhUnavailable = true;
      console.warn(
        'TinyBVH is unavailable; falling back to the built-in BVH builder.',
        error
      );
    } finally {
      // Anything TinyBVH could not prepare is built by the pipeline instead
      // of being retried every frame.
      pending.forEach((mesh) =>
        this._bvhPreparedGeometry.set(mesh, [mesh.geometry, mesh.geometry.version])
      );
    }
  }

  private _needsBVHPreparation(meshes: Mesh[]) {
    if (this.bvhBuilder !== 'tinybvh' || this._tinyBvhUnavailable) return false;
    return !!this._bvhPreparation || meshes.some((mesh) => {
      const prepared = this._bvhPreparedGeometry.get(mesh);
      const attempted = prepared?.[0] === mesh.geometry &&
        prepared[1] === mesh.geometry.version;
      return !mesh.geometry.dynamic && !attempted && meshNeedsPrecompute(mesh);
    });
  }

  /** Discard the active accumulation without rebuilding persistent scene data. */
  restartSamples() {
    this._pipeline?.restartSamples();
    this._oidnRealtimeStaticDenoisePending = false;
    this._oidnRealtimeSceneUpdatePending = false;
    this._oidnFirstFrameDenoisePending = this.oidnRealtime;
    this._renderDone = false;
    this._oidnStatus = 0;
    this._oidnRevision++;
  }

  /**
   * Renders one deterministic, quality-oriented offline frame. Pilot samples
   * only choose a conservative per-pixel budget and never enter final color.
   */
  async renderOfflineFrame(
    scene: Scene,
    camera: Camera,
    options: OfflineFrameRenderOptions
  ): Promise<OfflineFrameRenderResult> {
    const samples = Math.max(1, Math.round(options.samples));
    const samplesPerBatch = Math.max(
      1,
      Math.round(options.samplesPerBatch ?? 8)
    );
    const sequenceOffset = Math.max(
      0,
      Math.round(options.sampleSequenceOffset ?? 0)
    );
    const timeoutMs = Math.max(options.timeoutMs ?? 600_000, 1_000);
    const targetBatchTimeMs =
      Number.isFinite(options.targetBatchTimeMs) &&
      options.targetBatchTimeMs! > 0
        ? Math.max(1, options.targetBatchTimeMs!)
        : undefined;
    const previewIntervalMs = Number.isFinite(options.previewIntervalMs)
      ? Math.max(0, options.previewIntervalMs!)
      : undefined;
    const { device } = await this.getGPUDeviceAndAdapter();
    const pipeline = this._pipeline;
    if (!pipeline) throw new Error('The rendering pipeline is not ready.');
    await this.prepareScene(scene);

    const saved = {
      maxSamples: this.maxSamples,
      allowMultipleSamplesPerFrame: this.allowMultipleSamplesPerFrame,
      interactivePreview: this.interactivePreview,
      oidn: this.oidn,
      oidnRealtime: this.oidnRealtime
    };
    let varianceHistory: OfflineVarianceHistory | undefined;

    const waitForWork = async (madeProgress: boolean) => {
      if (madeProgress && device) {
        await device.queue.onSubmittedWorkDone();
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    };
    const renderStage = async (
      targetSamples: number,
      stage: 'pilot' | 'final',
      stageSequenceOffset: number
    ) => {
      this.maxSamples = targetSamples;
      const adaptiveBatching = targetBatchTimeMs !== undefined && !!device;
      let currentSamplesPerBatch = adaptiveBatching
        ? 1
        : Math.min(samplesPerBatch, targetSamples);
      const configureBatch = () => {
        pipeline.setOfflineRenderOptions({
          samplesPerBatch: currentSamplesPerBatch,
          deferPostProcess: true,
          sampleSequenceOffset: stageSequenceOffset
        });
      };
      configureBatch();
      this.restartSamples();
      const startedAt = performance.now();
      let lastPreviewAt = startedAt;
      let lastSamples = -1;
      while (true) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? new Error('Offline rendering aborted.');
        }
        if (performance.now() - startedAt > timeoutMs) {
          throw new Error(`Timed out rendering the offline ${stage} pass.`);
        }
        const batchStartedAt = performance.now();
        const samplesBeforeBatch = Math.max(lastSamples, 0);
        const status = this.render(scene, camera);
        const rendered = this.getTotalSamplesRendered() ?? 0;
        const madeProgress = rendered !== lastSamples;
        if (madeProgress) {
          lastSamples = rendered;
          options.onProgress?.({
            stage,
            samples: Math.min(rendered, targetSamples),
            targetSamples
          });
          const previewAt = performance.now();
          if (
            stage === 'final' &&
            previewIntervalMs !== undefined &&
            rendered > 0 &&
            rendered < targetSamples &&
            previewAt - lastPreviewAt >= previewIntervalMs
          ) {
            pipeline.drawPostProcess();
            lastPreviewAt = previewAt;
          }
        }
        if (status === RENDER_STATUS_ERROR) {
          throw new Error(this._lastRenderError ?? 'Path tracing failed.');
        }
        if (status === RENDER_STATUS_DENOISING) {
          options.onProgress?.({
            stage: 'denoising',
            samples: targetSamples,
            targetSamples
          });
        }
        if (status === RENDER_STATUS_FINISHED && rendered >= targetSamples) {
          break;
        }
        await waitForWork(rendered > 0 && madeProgress);
        if (adaptiveBatching && madeProgress) {
          const renderedInBatch = rendered - samplesBeforeBatch;
          const batchTimeMs = performance.now() - batchStartedAt;
          if (renderedInBatch > 0 && batchTimeMs > 0) {
            const desiredSamplesPerBatch = Math.max(
              1,
              Math.min(
                samplesPerBatch,
                Math.round(
                  targetBatchTimeMs! * renderedInBatch / batchTimeMs
                )
              )
            );
            // Reduce immediately when a batch exceeds the interaction budget,
            // but ramp up conservatively to avoid oscillating on light scenes.
            const nextSamplesPerBatch =
              desiredSamplesPerBatch > currentSamplesPerBatch
                ? Math.min(
                    desiredSamplesPerBatch,
                    currentSamplesPerBatch * 2
                  )
                : desiredSamplesPerBatch;
            if (nextSamplesPerBatch !== currentSamplesPerBatch) {
              currentSamplesPerBatch = nextSamplesPerBatch;
              configureBatch();
            }
          }
        }
      }
      // The final draw also submits normalization, tone mapping, and optional
      // denoising output. Do not let an exporter snapshot the previous frame.
      if (device) await device.queue.onSubmittedWorkDone();
    };

    try {
      this.allowMultipleSamplesPerFrame = true;
      this.interactivePreview = false;
      this.oidnRealtime = false;

      const adaptive = options.adaptiveSampling;
      if (adaptive && device) {
        const pilotSamples = Math.min(
          samples,
          Math.max(2, Math.round(adaptive.pilotSamples ?? 8))
        );
        // Pilot and final use disjoint deterministic ranges. Temporarily detach
        // OIDN because the pilot normal output stores luminance moments.
        this.oidn = undefined;
        pipeline.setVarianceMoments(true);
        pipeline.setAdaptiveSamplingTargets(undefined);
        await renderStage(pilotSamples, 'pilot', sequenceOffset);
        const plan = await pipeline.prepareOfflineAdaptiveSampling({
          ...adaptive,
          maxSamples: samples
        });
        if (plan) {
          varianceHistory = plan.history;
          pipeline.setVarianceMoments(false);
          this.oidn = saved.oidn;
          await renderStage(
            plan.maximumTarget,
            'final',
            sequenceOffset + pilotSamples
          );
          return {
            samples: plan.maximumTarget,
            averageSamplesPerPixel: plan.averageTarget,
            pilotSamples,
            varianceHistory,
            adaptiveSampling: true
          };
        }
      }

      pipeline.setVarianceMoments(false);
      pipeline.setAdaptiveSamplingTargets(undefined);
      this.oidn = saved.oidn;
      await renderStage(samples, 'final', sequenceOffset);
      return {
        samples,
        averageSamplesPerPixel: samples,
        pilotSamples: 0,
        adaptiveSampling: false
      };
    } finally {
      pipeline.setVarianceMoments(false);
      pipeline.setAdaptiveSamplingTargets(undefined);
      pipeline.setOfflineRenderOptions({
        samplesPerBatch: 0,
        deferPostProcess: false,
        sampleSequenceOffset: 0
      });
      this.maxSamples = saved.maxSamples;
      this.allowMultipleSamplesPerFrame = saved.allowMultipleSamplesPerFrame;
      this.interactivePreview = saved.interactivePreview;
      this.oidn = saved.oidn;
      this.oidnRealtime = saved.oidnRealtime;
    }
  }

  /** Backend, timing and shader-compilation details, or `undefined` before initialization. */
  getDiagnostics(): RendererDiagnostics | undefined {
    if (!this._pipeline) return;
    let adapterName = '';
    if (this._gpuAdapterInfo) {
      adapterName =
        this._gpuAdapterInfo.description ||
        [this._gpuAdapterInfo.vendor, this._gpuAdapterInfo.device]
          .filter(Boolean)
          .join(' ');
    } else if (this._webglRenderer) {
      const gl = this._webglRenderer.gl;
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      adapterName = String(
        gl.getParameter(
          debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER
        ) || ''
      );
    }
    const auxiliaryDenoisers = this._oidn?.auxiliaryDenoisers;
    const oidn = this._oidn
      ? {
          beauty: this._oidn.getRuntimeInfo?.(),
          albedo: auxiliaryDenoisers?.albedo.getRuntimeInfo?.(),
          normal: auxiliaryDenoisers?.normal.getRuntimeInfo?.()
        }
      : undefined;
    return {
      ...this._pipeline.getDiagnostics(),
      adapterName,
      backend: this._gpuDevice ? 'webgpu' : 'webgl',
      height: this.canvas.height,
      width: this.canvas.width,
      oidn
    };
  }

  /** Device limits for the material texture atlas, or `undefined` before initialization. */
  getTextureAtlasLimits(): TextureAtlasLimits | undefined {
    if (this._gpuDevice) {
      return {
        maxTextureArrayLayers: this._gpuDevice.limits.maxTextureArrayLayers,
        maxTextureDimension2D: this._gpuDevice.limits.maxTextureDimension2D
      };
    }
    if (this._webglRenderer) {
      const gl = this._webglRenderer.gl;
      return {
        maxTextureArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
        maxTextureDimension2D: gl.getParameter(gl.MAX_TEXTURE_SIZE)
      };
    }
  }

  getWebGLRenderer() {
    return this._webglRenderer;
  }

  /** Whether the WebGPU backend is active (`false` for WebGL 2 or before initialization). */
  isUsingWebGPU() {
    return !!this._gpuDevice;
  }

  /**
   * Initializes the backend if needed and resolves the WebGPU device, adapter
   * and adapter info. The device is `undefined` on the WebGL 2 backend.
   */
  async getGPUDeviceAndAdapter() {
    if (!this._pipeline && !this._initing) {
      void this._initPipeline(this._preferWebGPU);
    }
    await this._pipelineInitedPromise;
    if (this._pipelineInitError) throw this._pipelineInitError;
    return {
      device: this._gpuDevice,
      adapter: this._gpuAdapter,
      adapterInfo: this._gpuAdapterInfo
    };
  }

  private async _initPipeline(preferWebGPU: boolean) {
    let gpuCreated = false;
    this._initing = true;
    this._pipelineInitError = undefined;
    if (preferWebGPU && typeof navigator !== 'undefined' && navigator.gpu) {
      try {
        const gpu = navigator.gpu;
        let gpuDevice = globalGPUDevice;
        let gpuAdapter = globalGPUAdapter;
        let gpuAdapterInfo = globalGPUAdapterInfo;
        if (!gpuDevice) {
          gpuAdapter = await gpu.requestAdapter({
            powerPreference: 'high-performance'
          });
          if (!gpuAdapter) {
            gpuAdapter = await gpu.requestAdapter();
          }
          if (!gpuAdapter) throw new Error('No WebGPU adapter is available');
          gpuAdapterInfo = (gpuAdapter as GPUAdapter & { info: GPUAdapterInfo }).info;

          // Optional features also benefit OIDN, which shares this device.
          const requiredFeatures: GPUFeatureName[] = [];
          for (const feature of [
            'timestamp-query',
            'bgra8unorm-storage',
            'shader-f16',
            'subgroups',
            'texture-formats-tier1',
            'texture-formats-tier2',
            'float32-filterable'
          ] as GPUFeatureName[]) {
            if (gpuAdapter.features.has(feature)) requiredFeatures.push(feature);
          }

          // Request the adapter limits. The defaults are too small for large
          // scenes and for OIDN's convolution workgroups.
          const adapterLimits = gpuAdapter.limits;
          gpuDevice = await gpuAdapter.requestDevice({
            requiredFeatures,
            requiredLimits: {
              maxComputeWorkgroupStorageSize:
                adapterLimits.maxComputeWorkgroupStorageSize,
              maxComputeWorkgroupsPerDimension:
                adapterLimits.maxComputeWorkgroupsPerDimension,
              maxStorageBufferBindingSize:
                adapterLimits.maxStorageBufferBindingSize,
              maxStorageBuffersPerShaderStage:
                adapterLimits.maxStorageBuffersPerShaderStage,
              maxSampledTexturesPerShaderStage:
                adapterLimits.maxSampledTexturesPerShaderStage,
              maxStorageTexturesPerShaderStage:
                adapterLimits.maxStorageTexturesPerShaderStage,
              maxBufferSize: adapterLimits.maxBufferSize,
              maxTextureArrayLayers: adapterLimits.maxTextureArrayLayers,
              maxComputeWorkgroupSizeX: adapterLimits.maxComputeWorkgroupSizeX,
              maxComputeInvocationsPerWorkgroup:
                adapterLimits.maxComputeInvocationsPerWorkgroup
            }
          });
          globalGPUAdapter = gpuAdapter;
          globalGPUAdapterInfo = gpuAdapterInfo ?? null;
          globalGPUDevice = gpuDevice;
        }

        this._gpuAdapter = gpuAdapter;
        this._gpuAdapterInfo = gpuAdapterInfo ?? undefined;
        this._gpuDevice = gpuDevice;
        this._pipeline = makeWGPURenderingPipeline(this.canvas, gpuDevice, {
          presentationFormat: gpu.getPreferredCanvasFormat()
        });
        gpuCreated = true;
      } catch (e) {
        console.error(e);
        console.error('WebGPU is not supported');
      }
    }
    if (!gpuCreated) {
      this._webglRenderer = new WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        depth: true,
        stencil: false,
        antialias: false,
        pixelRatio: 1,
        preserveDrawingBuffer: this._preserveDrawingBuffer,
        // PENDING
        premultipliedAlpha: false,
        parallelShaderCompile: true,
        powerPreference: 'high-performance'
      });

      this._pipeline = makeWebGLRenderingPipeline(this._webglRenderer);
    }
    this._pipeline!.setSize(this.canvas.width, this.canvas.height);

    this._initing = false;
    this._pipelineInited?.();
    this._pipelineInitedPromise = undefined;
  }

  private _reportRenderError(error: unknown): RenderStatus {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this._lastRenderError) {
      console.error(`Path tracing failed: ${message}`, error);
      this._lastRenderError = message;
    }
    return RENDER_STATUS_ERROR;
  }

  /**
   * Renders the scene progressively. Call once per animation frame; each call
   * adds samples until `maxSamples` is reached. Camera, mesh membership,
   * world matrices, resource references, lights and background changes are
   * detected automatically and restart accumulation. After editing material
   * parameters, geometry arrays or texture pixels/UV arrays in place, call
   * that material's, geometry's or texture's `markUpdated()`.
   * Unchanged scenes retain their accumulation. Both backends refit transforms
   * and incrementally upload changed geometry with stable attribute arrays.
   *
   * @param forceOutput Re-run post-processing (tone mapping, bloom) even if
   *   no new samples are rendered.
   * @returns The current {@link RenderStatus}.
   */
  render(scene: Scene, camera: Camera, forceOutput?: boolean): RenderStatus {
    if (this._pipelineInitError) {
      return this._reportRenderError(this._pipelineInitError);
    }
    if (this._initing) {
      return RENDER_STATUS_PREPARING;
    }

    const pipeline = this._pipeline;

    if (!pipeline) {
      this._initPipeline(this._preferWebGPU);
      return RENDER_STATUS_PREPARING;
    }

    const toneMappingParams = {
      exposure: this.toneMappingExposure,
      autoExposure: this.autoExposure,
      toneMapping: this.toneMapping,
      contrast: this.contrast,
      saturation: this.saturation,
      temperature: this.temperature,
      tint: this.tint,
      vignette: this.vignette
    } as const;

    if (pipeline.setOutput(this.output)) {
      this._renderDone = false;
    }

    if (pipeline.setBouncesAndClamping(this.bounces, this.clamping)) {
      this._renderDone = false;
    }
    if (pipeline.setDirectLightCandidates?.(this.directLightCandidates)) {
      this._renderDone = false;
    }
    if (pipeline.setAlphaBlendStrategy?.(this.alphaBlendStrategy)) {
      this._renderDone = false;
    }
    if (pipeline.setBevelSamples(this.bevelSamples)) {
      this._renderDone = false;
    }
    if (pipeline.setStratifiedSampling(this.useStratifiedSampling)) {
      this._renderDone = false;
    }
    if (
      pipeline.setShadowCatcherParams(
        this.shadowCatcherColor,
        this.shadowCatcherAlpha
      )
    ) {
      this._renderDone = false;
    }
    if (
      pipeline.setTransmissiveOutputAlphaMin(this.transmissiveOutputAlphaMin)
    ) {
      this._renderDone = false;
    }

    pipeline.setOnSampleRendered((...args) => {
      if (this.onSampleRendered) {
        this.onSampleRendered(...args);
      }
    });

    pipeline.setAllowsMultipleSamplesPerFrame(
      this.allowMultipleSamplesPerFrame
    );
    pipeline.setMaxTimePerTile(this.maxTimePerTile);
    pipeline.setMaxTimePreview(this.maxTimePreview);
    pipeline.setInteractivePreviewParams({
      enabled: this.interactivePreview,
      resolutionScale: this.previewResolutionScale,
      bounces: this.previewBounces,
      idleDelayMs: this.previewIdleDelayMs
    });
    pipeline.setMaxTiles(this.maxTiles);

    let needsRedrawPostProcess = forceOutput;
    if (pipeline.setHDROutputEnabled?.(this.hdrOutputEnabled)) {
      needsRedrawPostProcess = true;
    }
    if (
      pipeline.setBloomParams({
        intensity: this.bloomIntensity,
        threshold: this.bloomThreshold ?? 1,
        radius: this.bloomRadius ?? 0.6
      })
    ) {
      needsRedrawPostProcess = true;
    }
    if (pipeline.setToneMappingParams(toneMappingParams)) {
      needsRedrawPostProcess = true;
    }
    if (pipeline.setOverlay(scene.overlay)) {
      needsRedrawPostProcess = true;
    }

    // Initial scene setup is not an edit. Later updates share one interaction
    // signal so material, transform, lighting and background changes all preview.
    if (this._scenePipeline !== pipeline) {
      this._sceneChangeDetector.reset();
      this._scenePipeline = pipeline;
      this._sceneInitialized = false;
    }
    const sceneInitialized = this._sceneInitialized;
    const renderDoneBeforeSceneUpdate = this._renderDone;
    ensureMeshGeometryAttributes(scene.meshes);
    const changes = this._sceneChangeDetector.detect(scene);
    const atlasBudgetChanged = pipeline.setTextureAtlasBudget(this.textureAtlasBudgetBytes);
    this._forceMeshUpdate ||= atlasBudgetChanged;
    const meshContentChanged = changes.meshes !== 'none' || this._forceMeshUpdate;
    if (meshContentChanged && this._needsBVHPreparation(scene.meshes)) {
      this._bvhPreparation ??= this.prepareScene(scene.meshes).finally(() => {
        this._bvhPreparation = undefined;
        this._forceMeshUpdate = true;
      });
      return RENDER_STATUS_PREPARING;
    }
    let sceneChanged = meshContentChanged || changes.lights || changes.background;
    if (meshContentChanged) {
      const measureMeshSync = (globalThis as typeof globalThis & {
        __clayptMeasureMeshSync?: boolean
      }).__clayptMeasureMeshSync === true;
      const meshSyncStartedAt = measureMeshSync ? performance.now() : 0;
      pipeline.setMeshes(scene.meshes, changes.meshes === 'full' || this._forceMeshUpdate
        ? undefined : { transforms: changes.transforms, materials: changes.materials, geometries: changes.geometries });
      if (measureMeshSync) {
        performance.measure('claypt:setMeshes', { start: meshSyncStartedAt, end: performance.now() });
      }
      this._forceMeshUpdate = false;
    }
    if (changes.lights) pipeline.setLights(scene.lights);
    if (changes.background) pipeline.setBackground(scene.background);
    this._sceneChangeDetector.commit();
    this._sceneInitialized = true;
    if (sceneChanged) this._renderDone = false;

    const oidn = this.oidn;
    const supportsOIDN = !!(pipeline as WGPURenderingPipeline)
      .performOIDNDenoise;
    const canRunOIDN = !!oidn && this.output === 'final' && supportsOIDN;
    const realtimeRequested =
      this.oidnRealtime && this.output === 'final' && supportsOIDN;
    const samplesBeforeRestart =
      pipeline.getTotalSamplesRendered() ?? 0;
    const previewModeActiveBeforeRestart =
      this.interactivePreview && pipeline.isPreviewMode?.() === true;
    const realtimeDenoiseInFlight = realtimeRequested && canRunOIDN;
    const deferSceneRestart =
      this.oidnRealtimeSceneUpdates &&
      sceneInitialized &&
      sceneChanged &&
      realtimeDenoiseInFlight &&
      this._oidnStatus === OIDN_DENOISING &&
      renderDoneBeforeSceneUpdate;
    if (deferSceneRestart) {
      this._oidnRealtimeSceneUpdatePending = true;
      this._renderDone = true;
    }
    const pendingSceneRestart =
      this._oidnRealtimeSceneUpdatePending && !deferSceneRestart;
    if (pendingSceneRestart) this._renderDone = false;
    const deferRestart = deferSceneRestart || (
      realtimeDenoiseInFlight &&
      this._oidnStatus === OIDN_DENOISING &&
      this._renderDone
    );
    const interactionRestarted = !deferRestart &&
      pipeline.needsRestartSample(
        camera,
        sceneInitialized && (sceneChanged || pendingSceneRestart)
      );
    if (pendingSceneRestart) {
      this._oidnRealtimeSceneUpdatePending = false;
    }
    if (interactionRestarted) {
      this._renderDone = false;
    }
    const previewModeActive =
      this.interactivePreview && pipeline.isPreviewMode?.() === true;
    const previewModeEnded =
      previewModeActiveBeforeRestart && !previewModeActive;
    if (previewModeEnded) {
      this._oidnRealtimeStaticDenoisePending = false;
      // The last interactive sample is normally already marked denoised.
      // Invalidate that status so the first settled full-quality frame cannot
      // remain on the raw path-traced output until the next batch completes.
      if (
        realtimeRequested &&
        canRunOIDN &&
        this._oidnStatus !== OIDN_DENOISING
      ) {
        this._oidnStatus = 0;
        this._oidnRevision++;
      }
    } else if (
      realtimeRequested &&
      interactionRestarted &&
      !previewModeActive &&
      samplesBeforeRestart > 0
    ) {
      this._oidnRealtimeStaticDenoisePending = true;
    }
    const realtimeDenoiseActive = realtimeRequested && canRunOIDN;
    const realtimeLowLatency =
      realtimeRequested && (interactionRestarted || previewModeActive);
    const renderedSamples = pipeline.getTotalSamplesRendered() ?? 0;
    const denoiseInFlight =
      deferRestart && this._oidnStatus === OIDN_DENOISING;
    const staticTransitionDenoise =
      this._renderDone &&
      !denoiseInFlight &&
      realtimeRequested &&
      canRunOIDN &&
      !interactionRestarted &&
      !previewModeActive &&
      this._oidnRealtimeStaticDenoisePending;
    const settledFrameDenoise =
      realtimeRequested && canRunOIDN && previewModeEnded && !previewModeActive;
    if (
      settledFrameDenoise ||
      (realtimeRequested && (
        interactionRestarted || pipeline.isFirstFrame() || renderedSamples === 0
      ))
    ) {
      this._oidnFirstFrameDenoisePending = true;
    }
    const firstFrameDenoise = canRunOIDN &&
      this._oidnFirstFrameDenoisePending;
    if (previewModeEnded) {
      pipeline.setPreviewTransitionDenoisePending?.(settledFrameDenoise);
    }
    if (staticTransitionDenoise) {
      this._oidnRealtimeStaticDenoisePending = false;
      this._oidnStatus = 0;
      this._oidnRevision++;
    }
    const sampleTarget = denoiseInFlight
      ? renderedSamples
      : firstFrameDenoise
      // Restarts can still report the previous frame's sample count until
      // draw() clears it. A newly attached model can reuse a held sample.
      ? interactionRestarted || pipeline.isFirstFrame()
        ? 1
        : Math.max(1, renderedSamples)
      : staticTransitionDenoise
      ? renderedSamples
      : realtimeLowLatency || (realtimeRequested && !canRunOIDN)
      ? 1
      : realtimeRequested
      ? Math.min(
          this.maxSamples,
          Math.ceil((renderedSamples + 1) / this.oidnRealtimeSampleInterval) *
            this.oidnRealtimeSampleInterval
        )
      : this.maxSamples;
    // A restarted tiled image stays at 0spp until every pixel is sampled.
    // Hold the completed denoise through that interval as well as later batches.
    // Animation presents at OIDN throughput, so keep its last completed result
    // visible while the latest coalesced scene state is traced and denoised.
    pipeline.setPreserveOIDNOutput?.(
      realtimeRequested && canRunOIDN &&
        (this.oidnRealtimeSceneUpdates || (
          !interactionRestarted && !previewModeActive
        ))
    );
    if (pipeline.getTotalSamplesRendered() < sampleTarget) {
      this._renderDone = false;
    }

    let compilingShader = false;
    if (!this._renderDone) {
      try {
        compilingShader = pipeline.draw(camera, sampleTarget);
      } catch (error) {
        this._reportRenderError(error);
        throw error;
      }
    } else if (needsRedrawPostProcess) {
      pipeline.drawPostProcess();
    }

    // Must set before sampled check. In case the render is finished in one frame.
    if (!this._renderDone) {
      // Reset
      this._oidnStatus = 0;
      this._oidnRevision++;
    }

    this._renderDone = pipeline.getTotalSamplesRendered() >= sampleTarget;

    if (this._renderDone && !this._oidnStatus && canRunOIDN) {
      this._oidnStatus = OIDN_DENOISING;
      const oidnRevision = ++this._oidnRevision;
      // Performing denoising
      (pipeline as WGPURenderingPipeline)
        .performOIDNDenoise(oidn!, this.oidnAlpha, realtimeDenoiseActive)
        .then((completed) => {
          if (oidnRevision !== this._oidnRevision) return;
          // The denoiser may finish without a progress callback (for example
          // a single whole-image execution). Submit the completed OIDN
          // texture explicitly so the first denoised frame reaches the
          // presentation surface.
          if (completed) {
            pipeline.drawPostProcess();
            this._oidnFirstFrameDenoisePending = false;
          }
          this._oidnStatus = completed ? OIDN_DENOISED : 0;
        })
        .catch((error) => {
          if (oidnRevision !== this._oidnRevision) return;
          this._oidnStatus = 0;
          console.error('Failed to denoise WebGPU output.', error);
        });
    }

    this._lastRenderError = undefined;
    return compilingShader
      ? RENDER_STATUS_COMPILING_SHADER
      : this._oidnStatus === OIDN_DENOISING
      ? RENDER_STATUS_DENOISING
      : this._renderDone && !needsRedrawPostProcess
      ? RENDER_STATUS_FINISHED
      : RENDER_STATUS_RENDERING;
  }

  /** Redraws post-processing so `canvas.toDataURL()` sees the latest image. */
  prepareForExport() {
    if (this.isUsingWebGPU()) {
      // Needs do an extra draw. Or the export will be last frame.
      this._pipeline?.drawPostProcess();
    }
  }

  /**
   * Reads back the linear HDR image (denoised when available) as RGBA
   * float32, top row first.
   */
  async getRawOutput() {
    if (!this._pipeline) {
      return {
        width: 0,
        height: 0,
        data: new Float32Array(0)
      };
    }
    const { data, width, height, flipY } = await this._pipeline!.getRawOutput();

    // Flip y pixels
    if (flipY) {
      for (let y = 0; y < Math.floor(height / 2); y++) {
        for (let x = 0; x < width; x++) {
          for (let c = 0; c < 4; c++) {
            const i1 = (y * width + x) * 4 + c;
            const i2 = ((height - y - 1) * width + x) * 4 + c;
            const temp = data[i1];
            data[i1] = data[i2];
            data[i2] = temp;
          }
        }
      }
    }
    return { data, width, height };
  }

  /** Releases GPU resources and the attached denoiser. */
  dispose() {
    this._oidnRevision++;
    this._denoiserRevision++;
    disposeOIDNDenoiser(this._ownedDenoiser);
    this._ownedDenoiser = undefined;
    this._webglRenderer?.dispose();
    this._pipeline?.dispose();
    this._pipeline = undefined;
  }
}
