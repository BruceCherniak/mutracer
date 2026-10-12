import { getGeometryBvh, type BvhBuildConfig } from './renderer/geometryBvh.js';
import { getPreparedMeshGeometry } from './renderer/prepareMeshBVH.js';
import { Events } from './util/events.js';
import { validateSceneLights } from './renderer/lightsUtil.js';
import type { SamplingPattern } from './renderer/sampling.js';
import { packDepthSampleArea, type DepthSampleArea } from './renderer/depthQuery.js';
import { ensureMeshGeometryAttributes, meshNeedsStaticBvh } from './renderer/prepareMeshBVH.js';
import {
  DEFAULT_BEVEL_SAMPLES,
  DEFAULT_DIRECT_LIGHT_CANDIDATES,
  AlphaBlendStrategy,
  RenderOutput,
  RenderingDiagnostics,
  RenderingPipeline,
  ToneMapping,
  normalizeBevelSamples
} from './renderer/RenderingPipeline.js';
import makeWebGLRenderingPipeline from './renderer/WebGLRenderingPipeline.js';
import { Renderer as WebGLRenderer } from './renderer/webgl.js';
import Mesh from './scene/Mesh.js';
import { SceneChangeDetector } from './renderer/sceneChangeDetector.js';
import type Geometry from './scene/Geometry.js';
import type { TinyBvhLayout } from './tinybvh/TinyBvhBuilder.js';
import Camera from './scene/Camera.js';
import { Scene } from './scene/Scene.js';
import { ColorRGB } from './types.js';
import type { OIDNDenoiser, OIDNModel } from './oidn.js';
import {
  createJNLMDenoiser,
  isJNLMDenoiser,
  type JNLMDenoiser,
  type JNLMOptions
} from './renderer/jnlm.js';
import { prepareStaticBvhs } from './renderer/staticBvhPreparation.js';
import { canUseBvhWorker, BvhWorkerPool, resolveBvhWorkerCount } from './renderer/bvhWorkerClient.js';
import makeWGPURenderingPipeline, {
  OIDNWeb
} from './renderer/WGPURenderingPipeline.js';
import { DEFAULT_MAX_TEXTURE_ARRAY_BYTES } from './renderer/MergedMaterialData.js';
import {
  type OfflineAdaptiveSamplingOptions,
  type OfflineVarianceHistory
} from './renderer/OfflineAdaptiveSampling.js';
export type { DepthSampleArea } from './renderer/depthQuery.js';
/** BLAS builder for meshes without a precomputed BVH. See {@link Renderer.bvhBuilder}. */
export type BVHBuilder = 'tinybvh' | 'builtin';

/** Optional early BVH construction settings. */
export interface PrebuildBVHOptions {
  /** Called after each completed BLAS with a fraction 0–1. Default none. */ onProgress?: (progress: number) => void;
  /** Cancels this preparation and rejects with its abort reason. Default undefined. */ signal?: AbortSignal;
}

/**
 * Denoiser implementation. `'jnlm'` is the built-in joint non-local means
 * filter: no download, tens of milliseconds per image, WebGPU and WebGL 2.
 * `'oidn'` runs Intel Open Image Denoise networks (WebGPU only), which are
 * slower but cleaner at very low sample counts.
 */
export type DenoiserType = 'oidn' | 'jnlm';

/** Options for {@link Renderer.setDenoiser}. */
export interface DenoiserOptions extends JNLMOptions {
  /**
   * Denoiser implementation. Default `'jnlm'`, or `'oidn'` when `model` or
   * `weightsBaseUrl` is given.
   */
  type?: DenoiserType;
  /**
   * OIDN network (`'oidn'` only). `standard` (default) balances quality and speed, `small`
   * is fastest, `cleanAuxLarge` prefilters the albedo/normal guides and gives
   * the cleanest result at the highest cost.
   */
  model?: OIDNModel;
  /**
   * Directory overriding all `.tza` weights. Defaults to bundled standard/small
   * assets and the oidn-weights CDN for large networks.
   */
  weightsBaseUrl?: string | URL;
  /**
   * Denoise while converging: interactive preview frames and every
   * `sampleInterval` samples, not only the image at `maxSamples`.
   * Default `false`.
   */
  whileConverging?: boolean;
  /**
   * Samples between denoised updates with `whileConverging`. A positive
   * integer. By default updates double the sample count (1, 4, 8, 16, …
   * samples), so the number of denoises grows logarithmically and does not
   * depend on resolution, with an update at least every 10 seconds.
   * Default `undefined` (doubling).
   */
  sampleInterval?: number;
  /**
   * With `whileConverging`, coalesce continuous scene changes while a denoise
   * is running and then render the latest scene state, instead of restarting
   * on every change. Intended for animation playback. Default `false`.
   */
  coalesceSceneUpdates?: boolean;
  /**
   * OIDN network for interactive preview frames when `whileConverging` is on.
   * Those frames are replaced as soon as the camera moves again, so the
   * default trades detail for speed; `false` uses `model`. Default `'small'`.
   */
  previewModel?: OIDNModel | false;
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
   * Enable denoising. `true` uses the default {@link DenoiserOptions} (the
   * built-in JNLM filter, which also runs on WebGL 2). Equivalent to calling
   * `setDenoiser()`. Default `false`.
   */
  denoiser?: boolean | DenoiserOptions;
  /**
   * Warn when material parameters change without markUpdated(), checking at most
   * 200 materials per render. Texture changes detected automatically are excluded.
   * Default: enabled in development builds, disabled in production and native browser ESM.
   */
  validateUpdates?: boolean;
  /** WebGL 2 `preserveDrawingBuffer`, needed to read the canvas back. Default `true`. */
  preserveDrawingBuffer?: boolean;
}

/** Snapshot returned by {@link Renderer.getDiagnostics}. */
export interface RendererDiagnostics extends RenderingDiagnostics {
  /** Synchronous failure from the most recent render call. Async failures are delivered through error events. */
  lastError?: string;
  /** Reason WebGPU initialization fell back to WebGL; absent when no fallback occurred. */
  webgpuFallbackReason?: string;
  /** GPU adapter description reported by the browser. */
  adapterName: string;
  /** Active rendering backend; 'webgpu' or 'webgl'. */
  backend: 'webgpu' | 'webgl' | undefined;
  /** Render height in pixels. */
  height: number;
  /** Render width in pixels. */
  width: number;
  /** Runtime information reported by oidn-web, when a denoiser is attached. */
  oidn?: {
    beauty: unknown;
    albedo?: unknown;
    normal?: unknown;
  };
}

/** Backend information resolved by init(). */
export interface RendererInfo {
  /** Active backend. */ backend: 'webgpu' | 'webgl';
  /** Browser-reported adapter description. */ adapterName: string;
  /** WebGPU fallback reason; absent without fallback. */ webgpuFallbackReason?: string;
  /** Device-dependent texture atlas limits. */ limits: TextureAtlasLimits;
}

/** Device limits that bound the material texture atlas. */
export interface TextureAtlasLimits {
  /** Maximum supported material-atlas layers; device dependent. */
  maxTextureArrayLayers: number;
  /** Maximum supported atlas edge length in pixels; device dependent. */
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
  /** Two-stage variance allocation. Default undefined. WebGPU only; ignored on WebGL (fixed spp). */
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
  /** Per-tile pilot variance history; undefined without adaptive sampling. */
  varianceHistory?: OfflineVarianceHistory;
  /** Whether adaptive allocation was used; false for fixed sampling. */
  adaptiveSampling: boolean;
}



/** Value returned by render(); initial renderer status is preparing. */
export type RenderStatus = 'preparing' | 'compiling' | 'previewing' | 'converging' | 'denoising' | 'finished' | 'error';

interface RendererEvents {
  sample: { samples: number; preview: boolean; isFirstFrame: boolean; frameTimeMs: number };
  status: { status: RenderStatus; previous: RenderStatus };
  progress: { stage: 'device' | 'bvh' | 'shaders'; progress: number };
  error: Error;
  denoised: { samples: number; final: boolean };
  devicelost: { reason: string; recovering: boolean };
}

const OIDN_DENOISING = 1;
const OIDN_DENOISED = 2;
/** Default while-converging schedule: sample count of the first batch update. */
const OIDN_ADAPTIVE_FIRST_SAMPLES = 4;
/** Sample growth between later updates. */
const OIDN_ADAPTIVE_SAMPLE_RATIO = 2;
/** Update at least this often while the doubling batches grow long. */
const OIDN_ADAPTIVE_MAX_INTERVAL_MS = 10000;

/** Denoising behavior set by {@link Renderer.setDenoiser}. */
interface DenoiseMode {
  whileConverging: boolean;
  /** Fixed samples between updates; `undefined` doubles the sample count. */
  sampleInterval: number | undefined;
  coalesceSceneUpdates: boolean;
}

function validateSampleInterval(value: number | undefined) {
  if (value === undefined) return value;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('sampleInterval must be a positive integer');
  }
  return value;
}

declare const process: { env: { NODE_ENV?: string } };
function isDevelopment() {
  try { return process.env.NODE_ENV !== 'production'; } catch { return false; }
}

let oidnModule: Promise<typeof import('./oidn.js')> | undefined;
/** OIDN (and oidn-web) is only fetched when a denoiser is requested. */
function loadOIDNModule() {
  return (oidnModule ??= import('./oidn.js'));
}

type AttachedDenoiser = OIDNWeb | JNLMDenoiser;

function disposeOIDNDenoiser(denoiser?: OIDNDenoiser | JNLMDenoiser) {
  if (isJNLMDenoiser(denoiser)) return denoiser.dispose();
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
  previewTargetFrameMs = 20;

  /**
   * Light candidates resampled for each next-event estimate (WebGPU). More
   * candidates reduce noise in scenes with many lights at a higher cost per
   * sample. Interactive preview uses at most two. Clamped to 1–16. Default `4`.
   * WebGPU only; ignored on WebGL.
   */
  directLightCandidates = DEFAULT_DIRECT_LIGHT_CANDIDATES;

  /**
   * Primary-ray handling of alpha-blended (glTF `BLEND`) materials on WebGPU.
   * `stochastic` treats alpha as coverage per sample; `deterministic-source-over`
   * splits the primary ray and blends both sides every sample. Default `stochastic`.
   * WebGPU only; ignored on WebGL.
   */
  alphaBlendStrategy: AlphaBlendStrategy = 'stochastic';

  /**
   * Render a cheaper, lower-resolution image while the camera or scene is
   * changing, then resume full quality. whileConverging forces preview on
   * regardless of this setting. Animation stays at preview quality until edits
   * stop. Default `true`.
   */
  previewEnabled = true;
  /** Maximum resolution scale used by interactive preview (0.25–1). Default `0.5`. */
  previewMaxResolutionScale = 0.5;
  /** Path depth used by interactive preview. Default `2`. */
  previewBounces = 2;
  /** Milliseconds without changes before full-quality rendering resumes. Default `150`. */
  previewIdleDelayMs = 150;

  /** Upper bound for the number of tiles per frame. Default `Infinity`. */
  maxTiles = Infinity;

  /**
   * BLAS builder used for meshes without a precomputed BVH. `builtin` builds
   * in a Worker using JavaScript (TinyBVH's binned SAH builder). `tinybvh`
   * loads WebAssembly in the Worker on first use. Both prepare missing static
   * BLASes before the first frame; `render()` returns `'preparing'`
   * meanwhile. If Workers are unavailable, construction runs on the main
   * thread. TinyBVH failures fall back to `builtin`. Default `builtin`.
   */
  bvhBuilder: BVHBuilder = 'builtin';

  /**
   * Maximum Workers building independent static BLASes in parallel per renderer.
   * Default `'auto'`: hardwareConcurrency minus one, clamped to 1–4 (1 if
   * unavailable). Set a positive safe integer to override; `1` serializes builds.
   * Workers are created on demand and reused until dispose(). Changes apply
   * when the next preparation starts; active builds keep their current pool.
   * Without Worker support, construction stays on the calling thread.
   */
  get bvhWorkerCount(): number | 'auto' { return this._bvhWorkerCount; }
  set bvhWorkerCount(count: number | 'auto') {
    resolveBvhWorkerCount(count);
    this._bvhWorkerCount = count;
  }
  private _bvhWorkerCount: number | 'auto' = 'auto';
  private _bvhWorkerPool?: BvhWorkerPool;
  private _bvhPreparationRevision = 0;

  /**
   * With `bvhBuilder = 'tinybvh'`, build static BLASes with spatial splits
   * (SBVH). This lowers traversal cost on some scenes but builds several
   * times slower. Existing static BLASes rebuild automatically after the change. Default `false`.
   */
  bvhSpatialSplits = false;
  /**
   * Layout of static BLASes built with `bvhBuilder = 'tinybvh'`. All layouts
   * work on WebGPU and WebGL 2. The built-in builder and dynamic geometry
   * always use `'bvh2'`. Existing static BLASes rebuild automatically.
   * Displacement bounds use `'bvh2'`. Default `'bvh2'`.
   */
  bvhLayout: TinyBvhLayout = 'bvh2';
  private _bvhPreparation?: Promise<void>;
  private _bvhPreparationTail: Promise<unknown> = Promise.resolve();
  private _tinyBvhUnavailable = false;
  private _bvhWorkerUnavailable = false;
  /** Geometry (and its version) each mesh had when preparation last failed. */
  private _bvhPreparedGeometry = new WeakMap<Mesh, [Geometry, number]>();

  /**
   * Memory budget in bytes for the packed material texture atlas. Larger
   * textures are downscaled to fit. Default 384 MiB.
   */
  textureAtlasBudgetBytes = DEFAULT_MAX_TEXTURE_ARRAY_BYTES;

  /** Canvas the renderer draws into. */
  readonly canvas: HTMLCanvasElement;

  private _events = new Events<RendererEvents>();
  /** Subscribes to renderer events; returns a function that cancels this subscription. */
  on<K extends keyof RendererEvents>(event: K, listener: (value: RendererEvents[K]) => void): () => void {
    return this._events.on(event, listener);
  }

  /** Linear exposure multiplier applied before tone mapping. Default `1`. */
  toneMappingExposure = 1;
  /** Display transform. Default `agx`. */
  toneMapping: ToneMapping = 'agx';
  /**
   * Present extended-range (HDR) values on displays and browsers that support
   * WebGPU HDR canvases, without display-referred tone mapping. Default `false`.
   * WebGPU only; ignored on WebGL.
   */
  hdrOutputEnabled = false;
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

  /**
   * Sampling pattern. Default `'sobol'` (suited to OIDN). `'zsobol'` uses
   * blue-noise-first ZSobol for low sample counts; `'random'` is PCG white noise.
   * The pattern is independent of the denoiser.
   */
  samplingPattern: SamplingPattern = 'sobol';

  /** Bloom intensity. `0` disables bloom. Default `0`. */
  bloomIntensity = 0;
  /** Luminance above which pixels contribute to bloom. Default `1`. */
  bloomThreshold = 1;
  /** Bloom radius (0–1). Default `0.6`. */
  bloomRadius = 0.6;

  private _activeDenoiser?: AttachedDenoiser;

  /**
   * Resolve camera changes as one-sample OIDN frames, then accumulate static
   * while-converging frames in denoise-sized batches.
   *
   * While a denoise is running, camera-only changes are coalesced so the GPU
   * never accumulates a queue of obsolete OIDN work. Scene changes normally
   * invalidate immediately; animation playback may opt into latest-frame
   * coalescing with `coalesceSceneUpdates`.
   */
  private _denoiseMode: DenoiseMode = {
    whileConverging: false,
    sampleInterval: undefined,
    coalesceSceneUpdates: false
  };
  /** Sample count of the last settled while-converging denoise. */
  private _oidnBatchStartSamples = 0;
  /** When accumulation resumed after that denoise. */
  private _oidnBatchStartTime?: number;
  private _oidnSceneUpdatePending = false;
  /** Re-denoise the first settled frame after a camera gesture. */
  private _oidnStaticDenoisePending = false;
  /** Hold the first sample target through compilation, tiling and OIDN. */
  private _oidnFirstFrameDenoisePending = false;

  private get _whileConverging() {
    return this._denoiseMode.whileConverging;
  }

  private _setDenoiseMode(mode: Partial<DenoiseMode>) {
    const next = { ...this._denoiseMode, ...mode };
    const changed = next.whileConverging !== this._denoiseMode.whileConverging;
    this._denoiseMode = next;
    if (!changed) return;
    this._oidnStaticDenoisePending = false;
    this._oidnSceneUpdatePending = false;
    this._oidnFirstFrameDenoisePending = next.whileConverging;
    this._prepareOIDNForCurrentSize();
    this._pipeline?.restartSamples();
    this._renderDone = false;
    this._oidnStatus = 0;
    this._oidnRevision++;
  }

  /**
   * The attached OIDN denoiser; undefined by default. Prefer
   * {@link Renderer.setDenoiser}; assign directly only for denoisers loaded with `@meimu/mutracer/oidn` helpers. The
   * `setDenoiser()` mode (`whileConverging` and related options) stays as set.
   */
  get oidn(): OIDNWeb | undefined {
    const denoiser = this._activeDenoiser;
    return isJNLMDenoiser(denoiser) ? undefined : denoiser;
  }

  set oidn(denoiser: OIDNWeb | undefined) {
    this._attachDenoiser(denoiser);
  }

  private _attachDenoiser(denoiser: AttachedDenoiser | undefined) {
    if (this._activeDenoiser === denoiser) return;
    this._activeDenoiser = denoiser;
    this._oidnFirstFrameDenoisePending = this._whileConverging;
    // A newly selected network must run against the existing accumulation.
    this._oidnStatus = 0;
    this._oidnRevision++;
    this._prepareOIDNForCurrentSize();
  }

  private _prepareOIDNForCurrentSize() {
    const denoiser = this.oidn;
    if (!denoiser?.prepareForImage) return;
    if (this.canvas.width <= 0 || this.canvas.height <= 0) return;
    const options = { tileOverlap: this._whileConverging ? 80 : undefined };
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
        this._notifyError(error);
      });
    }
  }
  private _ownedDenoiser?: OIDNDenoiser | JNLMDenoiser;
  /** Whether the denoise in flight is for an interactive preview frame. */
  private _oidnPreviewInFlight = false;
  private _denoiseFinalInFlight = false;
  /** Faster network for while-converging interactive preview frames. */
  private _previewDenoiser?: OIDNDenoiser;
  private _denoiserRevision = 0;

  /** Image shown on the canvas, e.g. `albedo` or `normal` for debugging. Default `final`. */
  output: RenderOutput = 'final';

  private _gpuDevice?: GPUDevice;
  private _gpuAdapterInfo?: GPUAdapterInfo;

  private _preserveDrawingBuffer;
  private _preferWebGPU;
  private _pipelineInitError?: unknown;
  private _reportedErrors = new WeakSet<Error>();
  private _loggedErrorMessages = new Set<string>();
  /** Synchronous failure during the most recent render() call. Default undefined; cleared by the next render call. Async failures (including denoising) are delivered through the error event. */
  lastError: Error | undefined;
  private _webgpuFallbackReason?: string;

  private _sceneChangeDetector: SceneChangeDetector;
  private _scenePipeline: RenderingPipeline | undefined;
  private _sceneInitialized = false;
  private _forceMeshUpdate = false;
  // `undefined` is a valid "no background" scene value, so use `null` as the
  // uninitialized sentinel and force the pipeline to receive the initial
  // background state even when the scene starts without one.

  private _webglRenderer?: WebGLRenderer;
  private _pipeline?: RenderingPipeline;

  // Some status
  private _initPromise?: Promise<RendererInfo>;
  private _info?: RendererInfo;

  private _initing = false;
  private _renderDone = false;
  private _readingDepth = false;
  private _oidnStatus = 0;
  private _oidnRevision = 0;

  constructor(params: RendererParams = {}) {
    this._sceneChangeDetector = new SceneChangeDetector(params.validateUpdates ?? isDevelopment());
    this.canvas = params.canvas || document.createElement('canvas');
    this._preserveDrawingBuffer = params.preserveDrawingBuffer ?? true;
    this._preferWebGPU = params.preferWebGPU ?? true;
    if (params.denoiser) {
      this.setDenoiser(params.denoiser).catch((error) => {
        this._notifyError(error);
      });
    }

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

  /** Returns the current canvas width and height in pixels. */
  getSize() {
    return {
      width: this.canvas.width,
      height: this.canvas.height
    };
  }

  /** Initialization result. Default undefined until init() resolves. */
  get info(): RendererInfo | undefined { return this._info; }
  /** Active backend. Default undefined until initialization completes. */
  get backend(): RendererInfo['backend'] | undefined { return this._info?.backend; }
  /** WebGPU device. Default undefined before initialization and on WebGL. */
  get device(): GPUDevice | undefined { return this._gpuDevice; }
  /** Formal (non-preview) samples per pixel. Default 0 before initialization and during preview. */
  get samples(): number { return this._pipeline?.isPreviewMode() ? 0 : this._pipeline?.getTotalSamplesRendered() ?? 0; }

  /** Initializes the backend once; concurrent and repeated calls share the result. render() also initializes lazily. */
  init(): Promise<RendererInfo> {
    return this._initPromise ??= (async () => {
      if (!this._pipeline) await this._initPipeline(this._preferWebGPU);
      if (this._pipelineInitError) throw this._pipelineInitError;
      const diagnostics = this.getDiagnostics()!;
      const gl = this._webglRenderer?.gl;
      const limits = this._gpuDevice?.limits;
      this._info = {
        backend: this._gpuDevice ? 'webgpu' : 'webgl',
        adapterName: diagnostics.adapterName,
        webgpuFallbackReason: this._webgpuFallbackReason,
        limits: {
          maxTextureArrayLayers: limits?.maxTextureArrayLayers ?? gl?.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
          maxTextureDimension2D: limits?.maxTextureDimension2D ?? gl?.getParameter(gl.MAX_TEXTURE_SIZE)
        }
      };
      return this._info;
    })();
  }

  /** Completes pending GPU timestamp readback used by diagnostics. */
  async flushDiagnostics() {
    await this.init();
    await this._pipeline?.flushDiagnostics();
  }

  /**
   * Attaches a denoiser, replacing (and disposing) the previous one: the
   * built-in JNLM filter by default (WebGPU and WebGL 2), or an OIDN network
   * loaded on the renderer's WebGPU device with `type: 'oidn'`. Pass `false`
   * or `null` to disable denoising. OIDN rejects on WebGL or when its weights
   * cannot be loaded.
   */
  async setDenoiser(options: DenoiserOptions | boolean | null = true) {
    const revision = ++this._denoiserRevision;
    const previous = this._ownedDenoiser;
    const previousPreview = this._previewDenoiser;
    if (!options) {
      this._ownedDenoiser = undefined;
      this._previewDenoiser = undefined;
      if (previous && this._activeDenoiser === previous) this._attachDenoiser(undefined);
      this._setDenoiseMode({ whileConverging: false });
      disposeOIDNDenoiser(previous);
      disposeOIDNDenoiser(previousPreview);
      return;
    }
    const {
      whileConverging = false,
      sampleInterval,
      coalesceSceneUpdates = false,
      previewModel = 'small',
      type = options !== true && (options.model || options.weightsBaseUrl)
        ? 'oidn'
        : 'jnlm',
      strength = 1,
      searchRadius,
      patchRadius,
      albedoBandwidth,
      normalBandwidth,
      iterations,
      ...loadOptions
    } = options === true ? {} : options;
    validateSampleInterval(sampleInterval);
    const model = loadOptions.model ?? 'standard';
    let denoiser: OIDNDenoiser | JNLMDenoiser;
    let previewDenoiser: OIDNDenoiser | undefined;
    if (type === 'jnlm') {
      denoiser = createJNLMDenoiser({ strength, searchRadius, patchRadius, albedoBandwidth, normalBandwidth, iterations });
    } else {
      const { initializeOIDN } = await loadOIDNModule();
      [denoiser, previewDenoiser] = await Promise.all([
        initializeOIDN(this, { ...loadOptions, attach: false }),
        whileConverging && previewModel && previewModel !== model
          ? initializeOIDN(this, { ...loadOptions, model: previewModel, attach: false })
          : undefined
      ]);
    }
    if (revision !== this._denoiserRevision) {
      // A newer setDenoiser() call superseded this one.
      disposeOIDNDenoiser(denoiser);
      disposeOIDNDenoiser(previewDenoiser);
      return;
    }
    this._ownedDenoiser = denoiser;
    this._previewDenoiser = previewDenoiser;
    this._setDenoiseMode({ whileConverging, sampleInterval, coalesceSceneUpdates });
    this._attachDenoiser(denoiser);
    if (previous !== denoiser) disposeOIDNDenoiser(previous);
    disposeOIDNDenoiser(previousPreview);
  }

  private _lastBvhBuild?: { geometryCount: number; bvhTimeMs: number };
  private _lastBvhSettings = 'builtin/bvh2/false';
  private _bvhConfig(): BvhBuildConfig {
    return { builder: this.bvhBuilder, layout: this.bvhLayout, spatialSplits: this.bvhSpatialSplits };
  }

  /**
   * Optionally builds static BVHs early for a future scene, without initializing
   * the device or compiling shaders. render() does this automatically for its
   * scene. Default options: no progress callback or abort signal. Statistics
   * are available in getDiagnostics().bvh.lastBuild.
   */
  prebuildBVH(scene: Pick<Scene, 'meshes'> | Mesh[], options: PrebuildBVHOptions = {}): Promise<void> {
    const revision = this._bvhPreparationRevision;
    const preparation = this._bvhPreparationTail.then(async () => {
      const isCancelled = () => revision !== this._bvhPreparationRevision || options.signal?.aborted === true;
      if (isCancelled()) return;
      const meshes = Array.isArray(scene) ? scene : scene.meshes;
      const useWorker = canUseBvhWorker() && !this._bvhWorkerUnavailable;
      if (useWorker) {
        const count = resolveBvhWorkerCount(this.bvhWorkerCount);
        if (this._bvhWorkerPool?.size !== count) {
          this._bvhWorkerPool?.dispose();
          this._bvhWorkerPool = new BvhWorkerPool(count);
        }
      }
      const config = this._bvhConfig();
      const result = await prepareStaticBvhs(meshes, {
        config,
        builder: this.bvhBuilder === 'tinybvh' && !this._tinyBvhUnavailable ? 'tinybvh' : 'builtin',
        layout: this.bvhLayout, spatialSplits: this.bvhSpatialSplits,
        useWorker, workerPool: this._bvhWorkerPool, isCancelled,
        rebuild: false, onProgress: progress => {
          if (this._bvhPreparation === preparation && (this.status === 'preparing' || this.status === 'compiling')) this._events.emit('progress', {stage: 'bvh', progress});
          options.onProgress?.(progress);
        }
      });
      if (isCancelled()) return;
      if (result.workerUnavailable && !this._bvhWorkerUnavailable) {
        this._bvhWorkerUnavailable = true;
        this._bvhWorkerPool?.dispose();
        this._bvhWorkerPool = undefined;
        console.warn('BVH preparation failed; falling back to the main-thread BVH builder.');
      }
      if (result.tinyBvhUnavailable && !this._tinyBvhUnavailable) {
        this._tinyBvhUnavailable = true;
        console.warn('BVH preparation failed; falling back to the built-in BVH builder.');
      }
      result.failedMeshes.forEach(mesh => {
        this._bvhPreparedGeometry.set(mesh, [mesh.geometry, mesh.geometry.version]);
      });
      if (result.geometryCount > 0) this._forceMeshUpdate = true;
      this._lastBvhBuild = { geometryCount: result.geometryCount, bvhTimeMs: result.bvhTimeMs };
    });
    this._bvhPreparationTail = preparation.catch(() => undefined);
    const signal = options.signal;
    if (!signal) return preparation;
    return new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason ?? new DOMException('BVH preparation aborted', 'AbortError'));
      if (signal.aborted) { aborted(); return; }
      signal.addEventListener('abort', aborted, { once: true });
      preparation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  }

  private _needsBVHPreparation(meshes: Mesh[]) {
    if (this._bvhPreparation) return true;
    if ((this.bvhBuilder !== 'tinybvh' || this._tinyBvhUnavailable) &&
        (!canUseBvhWorker() || this._bvhWorkerUnavailable)) {
      return meshes.some(mesh => !!getGeometryBvh(getPreparedMeshGeometry(mesh)) && meshNeedsStaticBvh(mesh, this._bvhConfig()));
    }
    return meshes.some((mesh) => {
      const prepared = this._bvhPreparedGeometry.get(mesh);
      const attempted = prepared?.[0] === mesh.geometry &&
        prepared[1] === mesh.geometry.version;
      return !attempted && meshNeedsStaticBvh(mesh, this._bvhConfig());
    });
  }

  /** Discard the active accumulation without rebuilding persistent scene data. */
  restartSamples() {
    this._pipeline?.restartSamples();
    this._oidnStaticDenoisePending = false;
    this._oidnSceneUpdatePending = false;
    this._oidnFirstFrameDenoisePending = this._whileConverging;
    this._renderDone = false;
    this._oidnStatus = 0;
    this._oidnRevision++;
  }

  private async _waitUntilReady(scene: Scene, camera: Camera, signal?: AbortSignal): Promise<void> {
    const saved = { maxSamples: this.maxSamples, denoiser: this._activeDenoiser, preview: this.previewEnabled, whileConverging: this._whileConverging };
    // Prepare pipelines without consuming a random sample or denoising a warm-up frame.
    this.maxSamples = 0;
    this.previewEnabled = false;
    this._setDenoiseMode({ whileConverging: false });
    this._attachDenoiser(undefined);
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new DOMException('Rendering aborted', 'AbortError');
        const status = this.render(scene, camera);
        if (status === 'error') throw this.lastError ?? new Error('Path tracing failed');
        if (status !== 'preparing' && status !== 'compiling') return;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    } finally {
      this.maxSamples = saved.maxSamples;
      this.previewEnabled = saved.preview;
      this._setDenoiseMode({ whileConverging: saved.whileConverging });
      this._attachDenoiser(saved.denoiser);
    }
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
    await this.init();
    const device = this.device;
    const pipeline = this._pipeline;
    if (!pipeline) throw new Error('The rendering pipeline is not ready.');
    await this._waitUntilReady(scene, camera, options.signal);

    const saved = {
      maxSamples: this.maxSamples,
      allowMultipleSamplesPerFrame: this.allowMultipleSamplesPerFrame,
      previewEnabled: this.previewEnabled,
      denoiser: this._activeDenoiser,
      whileConverging: this._whileConverging
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
        const rendered = this.samples;
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
        if (status === 'error') {
          throw new Error(this.lastError?.message ?? 'Path tracing failed.');
        }
        if (status === 'denoising') {
          options.onProgress?.({
            stage: 'denoising',
            samples: targetSamples,
            targetSamples
          });
        }
        if (status === 'finished' && rendered >= targetSamples) {
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
      this.previewEnabled = false;
      this._setDenoiseMode({ whileConverging: false });

      const adaptive = options.adaptiveSampling;
      if (adaptive && device) {
        const pilotSamples = Math.min(
          samples,
          Math.max(2, Math.round(adaptive.pilotSamples ?? 8))
        );
        // Pilot and final use disjoint deterministic ranges. Temporarily detach
        // OIDN because the pilot normal output stores luminance moments.
        this._attachDenoiser(undefined);
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
          this._attachDenoiser(saved.denoiser);
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
      this._attachDenoiser(saved.denoiser);
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
      this.previewEnabled = saved.previewEnabled;
      this._attachDenoiser(saved.denoiser);
      this._setDenoiseMode({ whileConverging: saved.whileConverging });
    }
  }

  /** Backend, timing and shader-compilation details, or `undefined` before initialization. */
  getDiagnostics(): RendererDiagnostics | undefined {
    if (!this._pipeline && !this._lastBvhBuild) return;
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
    const attachedOIDN = this.oidn;
    const auxiliaryDenoisers = attachedOIDN?.auxiliaryDenoisers;
    const oidn = attachedOIDN
      ? {
          beauty: attachedOIDN.getRuntimeInfo?.(),
          albedo: auxiliaryDenoisers?.albedo.getRuntimeInfo?.(),
          normal: auxiliaryDenoisers?.normal.getRuntimeInfo?.()
        }
      : undefined;
    return {
      ...this._pipeline?.getDiagnostics(),
      bvh: { ...this._pipeline?.getDiagnostics().bvh, lastBuild: this._lastBvhBuild },
      adapterName,
      backend: this.backend,
      height: this.canvas.height,
      width: this.canvas.width,
      oidn,
      lastError: this.lastError?.message,
      webgpuFallbackReason: this._webgpuFallbackReason
    };
  }

  private async _initPipeline(preferWebGPU: boolean) {
    let gpuCreated = false;
    try {
      this._initing = true;
      this._events.emit('progress', {stage: 'device', progress: 0});
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

          this._gpuAdapterInfo = gpuAdapterInfo ?? undefined;
          this._gpuDevice = gpuDevice;
          this._pipeline = makeWGPURenderingPipeline(this.canvas, gpuDevice, {
            presentationFormat: gpu.getPreferredCanvasFormat()
          });
          gpuCreated = true;
        } catch (e) {
          this._webgpuFallbackReason = e instanceof Error ? e.message : String(e);
          this._gpuDevice = undefined;
          this._gpuAdapterInfo = undefined;
        }
      }
      if (!gpuCreated) {
        if (preferWebGPU && !this._webgpuFallbackReason) {
          this._webgpuFallbackReason = 'WebGPU is not available in this environment';
        }
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

    } catch (error) {
      this._pipelineInitError = error instanceof Error ? error : new Error(String(error));
      this._notifyError(this._pipelineInitError);
    } finally {
      this._initing = false;
      this._events.emit('progress', {stage: 'device', progress: 1});
    }
  }

  private _notifyError(value: unknown): Error {
    const error = value instanceof Error ? value : new Error(String(value));
    if (!this._loggedErrorMessages.has(error.message)) {
      this._loggedErrorMessages.add(error.message);
      console.error(`Path tracing failed: ${error.message}`, error);
    }
    if (!this._reportedErrors.has(error)) {
      this._reportedErrors.add(error);
      this._events.emit('error', error);
    }
    return error;
  }

  private _reportRenderError(error: unknown): RenderStatus {
    this.lastError = this._notifyError(error);
    return 'error';
  }

  /** Most recent render result. Default preparing. */
  get status(): RenderStatus { return this._status; }
  private _status: RenderStatus = 'preparing';

  /**
   * Renders the scene progressively. Call once per animation frame; each call
   * adds samples until `maxSamples` is reached. Camera, mesh membership,
   * world matrices, resource references, lights and background changes are
   * detected automatically and restart accumulation. After editing material
   * parameters or texture pixels/UV arrays in place, call that object's markUpdated().
   * For geometry vertex attributes with unchanged indices/materialIndex, call
   * markVerticesUpdated(); use markUpdated() for topology or general updates.
   * Unchanged scenes retain their accumulation. Both backends refit transforms
   * and incrementally upload changed geometry with stable attribute arrays.
   *
   * Errors are recorded in lastError and diagnostics; this method never throws.
   * @returns The current {@link RenderStatus}.
   */
  render(scene: Scene, camera: Camera): RenderStatus {
    const previous = this._status;
    this.lastError = undefined;
    try {
      this._status = this._render(scene, camera);
    } catch (error) {
      this._status = this._reportRenderError(error);
    }
    if (this._status === 'compiling') {
      const shaders = this._pipeline?.getDiagnostics().shaderCompilation;
      if (shaders && shaders.pipelineCount > 0) this._events.emit('progress', {stage:'shaders',progress:shaders.completedPipelineCount / shaders.pipelineCount});
    }
    if (previous !== this._status) this._events.emit('status', { status: this._status, previous });
    return this._status;
  }

  private _render(scene: Scene, camera: Camera): RenderStatus {
    if (this._pipelineInitError) {
      return this._reportRenderError(this._pipelineInitError);
    }
    if (this._initing) {
      return 'preparing';
    }

    const pipeline = this._pipeline;

    if (!pipeline) {
      void this.init().catch(() => {});
      return 'preparing';
    }

    const toneMappingParams = {
      exposure: this.toneMappingExposure,
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
    if (pipeline.setSamplingPattern(this.samplingPattern, this.maxSamples)) {
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

    pipeline.setOnSampleRendered((samples, isFirstFrame, frameTimeMs) => {
      this._events.emit('sample', { samples, isFirstFrame, frameTimeMs, preview: pipeline.isPreviewMode() });
    });

    pipeline.setAllowsMultipleSamplesPerFrame(
      this.allowMultipleSamplesPerFrame
    );
    pipeline.setMaxTimePerTile(this.maxTimePerTile);
    pipeline.setPreviewTargetFrameMs(this.previewTargetFrameMs);
    pipeline.setPreviewParams({
      enabled: this.previewEnabled || this._whileConverging,
      resolutionScale: this.previewMaxResolutionScale,
      bounces: this.previewBounces,
      idleDelayMs: this.previewIdleDelayMs
    });
    pipeline.setMaxTiles(this.maxTiles);

    let needsRedrawPostProcess = false;
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

    // Initial scene setup is not an edit. Later updates share one interaction
    // signal so material, transform, lighting and background changes all preview.
    if (this._scenePipeline !== pipeline) {
      this._sceneChangeDetector.reset();
      this._scenePipeline = pipeline;
      this._sceneInitialized = false;
    }
    const sceneInitialized = this._sceneInitialized;
    const renderDoneBeforeSceneUpdate = this._renderDone;
    validateSceneLights(scene.lights, error => this._notifyError(error));
    ensureMeshGeometryAttributes(scene.meshes);
    const changes = this._sceneChangeDetector.detect(scene);
    const atlasBudgetChanged = pipeline.setTextureAtlasBudget(this.textureAtlasBudgetBytes);
    this._forceMeshUpdate ||= atlasBudgetChanged;
    const bvhSettings = `${this.bvhBuilder}/${this.bvhLayout}/${this.bvhSpatialSplits}`;
    if (bvhSettings !== this._lastBvhSettings) {
      this._lastBvhSettings = bvhSettings;
      this._forceMeshUpdate = true;
      this._bvhPreparedGeometry = new WeakMap();
    }
    const meshContentChanged = changes.meshes !== 'none' || this._forceMeshUpdate;
    if (this._bvhPreparation || (meshContentChanged && this._needsBVHPreparation(scene.meshes))) {
      if (!this._bvhPreparation) {
        const preparation = this.prebuildBVH(scene.meshes);
        this._bvhPreparation = preparation;
        const finish = () => { if (this._bvhPreparation === preparation) this._bvhPreparation = undefined; };
        void preparation.then(finish, error => { finish(); this._notifyError(error); });
      }
      return 'preparing';
    }
    let sceneChanged = meshContentChanged || changes.lights || changes.background;
    if (meshContentChanged) {
      const measureMeshSync = (globalThis as typeof globalThis & {
        __mutracerMeasureMeshSync?: boolean
      }).__mutracerMeasureMeshSync === true;
      const meshSyncStartedAt = measureMeshSync ? performance.now() : 0;
      pipeline.setMeshes(scene.meshes, changes.meshes === 'full' || this._forceMeshUpdate
        ? undefined : { transforms: changes.transforms, materials: changes.materials, geometries: changes.geometries });
      if (measureMeshSync) {
        performance.measure('mutracer:setMeshes', { start: meshSyncStartedAt, end: performance.now() });
      }
      this._forceMeshUpdate = false;
    }
    if (changes.lights) pipeline.setLights(scene.lights);
    if (changes.background) pipeline.setBackground(scene.background);
    this._sceneChangeDetector.commit();
    this._sceneInitialized = true;
    if (sceneChanged) this._renderDone = false;

    const oidn = this._activeDenoiser;
    const supportsOIDN = !!pipeline.performOIDNDenoise;
    const canRunOIDN = !!oidn && this.output === 'final' && supportsOIDN;
    const convergingRequested =
      this._whileConverging && this.output === 'final' && supportsOIDN;
    const samplesBeforeRestart =
      pipeline.getTotalSamplesRendered() ?? 0;
    const previewModeActiveBeforeRestart =
      pipeline.isPreviewMode();
    const convergingDenoiseInFlight = convergingRequested && canRunOIDN;
    const deferSceneRestart =
      this._denoiseMode.coalesceSceneUpdates &&
      sceneInitialized &&
      sceneChanged &&
      convergingDenoiseInFlight &&
      this._oidnStatus === OIDN_DENOISING &&
      renderDoneBeforeSceneUpdate;
    if (deferSceneRestart) {
      this._oidnSceneUpdatePending = true;
      this._renderDone = true;
    }
    const pendingSceneRestart =
      this._oidnSceneUpdatePending && !deferSceneRestart;
    if (pendingSceneRestart) this._renderDone = false;
    // Interaction presents at OIDN throughput: a moving camera waits for the
    // preview frame being denoised. A settled multi-tile denoise is cancelled
    // instead, so it never holds up the next gesture.
    const deferRestart = deferSceneRestart || (
      convergingDenoiseInFlight &&
      this._oidnStatus === OIDN_DENOISING &&
      this._oidnPreviewInFlight &&
      this._renderDone
    );
    const interactionRestarted = !deferRestart &&
      pipeline.needsRestartSample(
        camera,
        sceneInitialized && (sceneChanged || pendingSceneRestart)
      );
    if (pendingSceneRestart) {
      this._oidnSceneUpdatePending = false;
    }
    if (interactionRestarted) {
      this._renderDone = false;
    }
    const previewModeActive =
      pipeline.isPreviewMode();
    const previewModeEnded =
      previewModeActiveBeforeRestart && !previewModeActive;
    if (previewModeEnded) {
      this._oidnStaticDenoisePending = false;
      // The last interactive sample is normally already marked denoised.
      // Invalidate that status so the first settled full-quality frame cannot
      // remain on the raw path-traced output until the next batch completes.
      if (
        convergingRequested &&
        canRunOIDN &&
        this._oidnStatus !== OIDN_DENOISING
      ) {
        this._oidnStatus = 0;
        this._oidnRevision++;
      }
    } else if (
      convergingRequested &&
      interactionRestarted &&
      !previewModeActive &&
      samplesBeforeRestart > 0
    ) {
      this._oidnStaticDenoisePending = true;
    }
    const convergingDenoiseActive = convergingRequested && canRunOIDN;
    const convergingLowLatency =
      convergingRequested && (interactionRestarted || previewModeActive);
    const renderedSamples = pipeline.getTotalSamplesRendered() ?? 0;
    // Hold every completed batch until OIDN presents it. Advancing the sample
    // target here would call draw(), cancelling the asynchronous denoise.
    // Camera and scene invalidation above still clear _renderDone immediately.
    const denoiseInFlight =
      convergingDenoiseActive && this._renderDone &&
      this._oidnStatus === OIDN_DENOISING;
    const staticTransitionDenoise =
      this._renderDone &&
      !denoiseInFlight &&
      convergingRequested &&
      canRunOIDN &&
      !interactionRestarted &&
      !previewModeActive &&
      this._oidnStaticDenoisePending;
    const settledFrameDenoise =
      convergingRequested && canRunOIDN && previewModeEnded && !previewModeActive;
    if (
      settledFrameDenoise ||
      (convergingRequested && (
        interactionRestarted || pipeline.isFirstFrame() || renderedSamples === 0
      ))
    ) {
      this._oidnFirstFrameDenoisePending = true;
    }
    const firstFrameDenoise = canRunOIDN &&
      this._oidnFirstFrameDenoisePending;
    if (staticTransitionDenoise) {
      this._oidnStaticDenoisePending = false;
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
      : convergingLowLatency || (convergingRequested && !canRunOIDN)
      ? 1
      : convergingRequested
      ? this._convergingSampleTarget(renderedSamples)
      : this.maxSamples;
    // A restarted tiled image stays at 0spp until every pixel is sampled.
    // Hold the completed denoise through that interval as well as later batches.
    // Animation presents at OIDN throughput, so keep its last completed result
    // visible while the latest coalesced scene state is traced and denoised.
    pipeline.setOIDNPreviewActive?.(convergingRequested && canRunOIDN);
    pipeline.setPreserveOIDNOutput?.(
      convergingRequested && canRunOIDN &&
        (this._denoiseMode.coalesceSceneUpdates || (
          !interactionRestarted && !previewModeActive
        ))
    );
    if (pipeline.getTotalSamplesRendered() < sampleTarget) {
      this._renderDone = false;
    }

    let compilingShader = false;
    if (!this._renderDone) {
      compilingShader = pipeline.draw(camera, sampleTarget);
    } else if (needsRedrawPostProcess) {
      pipeline.drawPostProcess();
    }

    if (needsRedrawPostProcess && canRunOIDN) {
      pipeline.cancelOIDNDenoise?.();
      this._oidnStatus = 0;
      this._oidnRevision++;
    }

    // Must set before sampled check. In case the render is finished in one frame.
    if (!this._renderDone) {
      // Reset
      this._oidnStatus = 0;
      this._oidnRevision++;
    }

    this._renderDone = pipeline.getTotalSamplesRendered() >= sampleTarget;

    if (this._renderDone && !this._oidnStatus && canRunOIDN && (!previewModeActive || convergingRequested)) {
      this._oidnStatus = OIDN_DENOISING;
      this._denoiseFinalInFlight = !previewModeActive && sampleTarget >= this.maxSamples;
      this._oidnPreviewInFlight = pipeline.isPreviewMode();
      const oidnRevision = ++this._oidnRevision;
      // While-converging preview frames use the faster preview network when loaded.
      const previewFrame = convergingDenoiseActive && this._previewDenoiser &&
        oidn === this._ownedDenoiser && pipeline.isPreviewMode();
      // Settled batches drive the doubling schedule; preview frames are
      // replaced as soon as the camera moves again.
      const settledBatch = convergingDenoiseActive && !this._oidnPreviewInFlight;
      if (settledBatch) {
        this._oidnBatchStartSamples = pipeline.getTotalSamplesRendered();
      }
      const denoisedSamples = pipeline.getTotalSamplesRendered();
      const final = this._denoiseFinalInFlight;
      // Performing denoising
      pipeline
        .performOIDNDenoise!(previewFrame ? this._previewDenoiser! : oidn!, undefined, convergingDenoiseActive)
        .then((completed) => {
          if (oidnRevision !== this._oidnRevision) return;
          if (settledBatch) this._oidnBatchStartTime = performance.now();
          // The denoiser may finish without a progress callback (for example
          // a single whole-image execution). Submit the completed OIDN
          // texture explicitly so the first denoised frame reaches the
          // presentation surface.
          this._oidnStatus = completed ? OIDN_DENOISED : 0;
          if (completed) {
            pipeline.drawPostProcess();
            this._oidnFirstFrameDenoisePending = false;
            this._events.emit('denoised', { samples: denoisedSamples, final });
          }
        })
        .catch((error) => {
          this._notifyError(error);
          if (oidnRevision !== this._oidnRevision) return;
          if (settledBatch) this._oidnBatchStartTime = performance.now();
          this._oidnStatus = 0;
        });
    }

    return compilingShader
      ? 'compiling'
      : previewModeActive
      ? 'previewing'
      : this._oidnStatus === OIDN_DENOISING && this._denoiseFinalInFlight
      ? 'denoising'
      : this._renderDone && pipeline.getTotalSamplesRendered() >= this.maxSamples && !needsRedrawPostProcess
      ? 'finished'
      : 'converging';
  }

  /**
   * Sample count at which the static while-converging image is denoised next.
   * Tiled passes can only stop at a pass boundary, so an update that is due
   * targets the end of the current pass.
   */
  private _convergingSampleTarget(renderedSamples: number) {
    const { maxSamples } = this;
    const interval = this._denoiseMode.sampleInterval;
    if (interval !== undefined) {
      return Math.min(
        maxSamples,
        Math.ceil((renderedSamples + 1) / interval) * interval
      );
    }
    if (
      this._oidnBatchStartTime !== undefined &&
      performance.now() - this._oidnBatchStartTime >= OIDN_ADAPTIVE_MAX_INTERVAL_MS
    ) {
      return Math.min(maxSamples, renderedSamples + 1);
    }
    // A restart that has not been denoised yet starts a new sequence.
    const last = this._oidnBatchStartSamples <= renderedSamples
      ? this._oidnBatchStartSamples
      : 0;
    const next = Math.max(
      OIDN_ADAPTIVE_FIRST_SAMPLES,
      Math.ceil(last * OIDN_ADAPTIVE_SAMPLE_RATIO)
    );
    return Math.min(maxSamples, Math.max(next, renderedSamples + 1));
  }

  /**
   * Redraws the current image, waits for queued GPU work and encodes it.
   * Default type image/png; quality undefined lets the browser choose.
   */
  async toBlob(options: {
    /** Browser image MIME type. Default image/png. */ type?: string;
    /** Encoder quality from 0 to 1. Default undefined uses the browser default. */ quality?: number;
  } = {}): Promise<Blob> {
    this._pipeline?.drawPostProcess();
    await this.device?.queue.onSubmittedWorkDone();
    const type = options.type ?? 'image/png';
    const canvas = this.canvas;
    if ('convertToBlob' in canvas) {
      return (canvas as unknown as OffscreenCanvas).convertToBlob({ type, quality: options.quality });
    }
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob); else reject(new Error('The canvas could not be encoded'));
      }, type, options.quality);
    });
  }

  /**
   * Queries a 7×7 grid of pinhole depths in the last rendered scene and camera,
   * asynchronously on either GPU backend. Distances are along the camera's
   * forward axis in scene units; missed or out-of-viewport samples are `0`.
   * The square area includes its edges, in row order from the top left.
   * Invisible shadow catchers and zero-opacity surfaces are skipped; glass
   * measures its front surface. Pixel jitter and depth of field are ignored.
   * Returns `undefined` before GPU scene preparation completes or while
   * another depth query is in flight. Call after {@link render}; no defaults.
   */
  async readDepthSamples(area: DepthSampleArea): Promise<Float32Array | undefined> {
    packDepthSampleArea(area, 1);
    const pipeline = this._pipeline;
    if (!pipeline || this._readingDepth) return;
    this._readingDepth = true;
    try {
      const data = await pipeline.readDepthSamples(area);
      return pipeline === this._pipeline ? data : undefined;
    } finally {
      this._readingDepth = false;
    }
  }

  private _warnedDenoisedReadback = false;
  /**
   * Reads RGBA float32 pixels, top row first. Default kind hdr.
   * hdr is linear; albedo is the native linear guide; normal RGB is encoded 0–1.
   * denoised preserves native output: WebGPU normally display-linear after composition (display encoded
   * after OIDN alpha postfilter), WebGL after tone mapping/display encoding.
   * Missing or unfinished denoising falls back to hdr and warns once.
   */
  async readPixels(kind: 'hdr' | 'denoised' | 'albedo' | 'normal' = 'hdr') {
    if (!this._pipeline) return {width: 0, height: 0, data: new Float32Array(0)};
    if (kind === 'denoised' && (!this._activeDenoiser || this._oidnStatus !== OIDN_DENOISED)) {
      if (!this._warnedDenoisedReadback) {
        this._warnedDenoisedReadback = true;
        console.warn('Denoised output is not ready; reading HDR samples instead.');
      }
      kind = 'hdr';
    }
    return this._pipeline.readOutput(kind);
  }

  /** Releases GPU resources, BVH Workers and the attached denoiser; cancels pending BVH preparation. */
  dispose() {
    this._events.clear();
    this._bvhPreparationRevision++;
    this._bvhWorkerPool?.dispose();
    this._bvhWorkerPool = undefined;
    this._oidnRevision++;
    this._denoiserRevision++;
    disposeOIDNDenoiser(this._ownedDenoiser);
    this._ownedDenoiser = undefined;
    disposeOIDNDenoiser(this._previewDenoiser);
    this._previewDenoiser = undefined;
    this._webglRenderer?.dispose();
    this._pipeline?.dispose();
    this._pipeline = undefined;
  }
}
