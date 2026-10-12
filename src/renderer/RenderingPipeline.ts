import type { SamplingPattern } from './sampling.js';
import type { DepthSampleArea } from './depthQuery.js';
import Camera from '../scene/Camera.js';
import Mesh from '../scene/Mesh.js';
import Geometry from '../scene/Geometry.js';
import OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import { SceneBackground, SceneLight } from '../scene/Scene.js';
import { ColorRGB } from '../types.js';
import { TextureAtlasStats } from './MergedMaterialData.js';
import type {
  OfflineAdaptiveSamplingOptions,
  OfflineAdaptiveSamplingResult
} from './OfflineAdaptiveSampling.js';

export type ToneMapping =
  | 'agx'
  | 'aces'
  | 'cineon'
  | 'reinhard'
  | 'linear';

export interface ToneMappingParams {
  /** Linear exposure multiplier. Default `1`. */
  exposure?: number;
  /** Display tone mapper. Default `agx`. */
  toneMapping?: ToneMapping;
  /** Contrast multiplier. Default `1`. */
  contrast?: number;
  /** Saturation multiplier. Default `1`. */
  saturation?: number;
  /** Color temperature adjustment in [-1, 1]. Default `0`. */
  temperature?: number;
  /** Green/magenta adjustment in [-1, 1]. Default `0`. */
  tint?: number;
  /** Vignette strength in [0, 1]. Default `0`. */
  vignette?: number;
}

export type RenderOutput =
  | 'final'
  | 'shadow'
  | 'albedo'
  | 'normal'
  | 'shadowCatcher';

/** Primary-ray policy for glTF BLEND materials. */
export type AlphaBlendStrategy =
  | 'stochastic'
  | 'deterministic-source-over';

/** Generated source measurements for one shader module. */
export interface ShaderModuleCompilationDiagnostics {
  /** Module or pipeline diagnostic label. */
  label: string;
  /** Generated shader source size in bytes. */
  sourceBytes: number;
  /** Generated shader source line count. */
  sourceLines: number;
  /** Stable source-level fingerprint for diagnosing cache-key churn. */
  sourceFingerprint: string;
}

/** Compilation measurements for one compute pipeline. */
export interface ShaderPipelineCompilationDiagnostics {
  /** Module or pipeline diagnostic label. */
  label: string;
  /** Compute entry-point name. */
  entryPoint: string;
  /**
   * Whether this pipeline belongs to the minimum set needed to present a
   * usable first image. Optional reuse and quality stages are false even
   * while the current eager compiler still waits for them.
   */
  firstFrameRequired: boolean;
  /** Current compilation state. */
  status: 'queued' | 'compiling' | 'ready' | 'failed';
  /** Milliseconds from the start of this pipeline compilation batch. */
  startedAtMs?: number;
  /** Milliseconds from the start of this pipeline compilation batch. */
  endedAtMs?: number;
  /** Pipeline compilation duration in milliseconds; undefined until completed. */
  durationMs?: number;
  /** Number of pipelines compiling when this one started; undefined before start. */
  concurrentCompilationCount?: number;
  /** Failure message; undefined without a compilation error. */
  error?: string;
}

/** Source generation and asynchronous pipeline compilation measurements. */
export interface ShaderCompilationDiagnostics {
  /** Current compilation state. */
  status: 'compiling' | 'ready' | 'failed';
  /** Generated shader source size in bytes. */
  sourceBytes: number;
  /** Generated shader source line count. */
  sourceLines: number;
  /** Total pipelines in the batch. */
  pipelineCount: number;
  /** Number of pipelines successfully completed. */
  completedPipelineCount: number;
  /** CPU shader source generation time in milliseconds. */
  sourceGenerationTimeMs: number;
  /** Shader module creation time in milliseconds. */
  moduleCreationTimeMs: number;
  /** Per-module source measurements. */
  modules: ShaderModuleCompilationDiagnostics[];
  /** Per-pipeline timing and status measurements. */
  pipelines: ShaderPipelineCompilationDiagnostics[];
  /** Configured pool size, capped to the number of pipelines in this batch. */
  maximumConcurrentPipelineCount: number;
  /** Largest number of createComputePipelineAsync calls active at once. */
  peakConcurrentPipelineCount: number;
  /** Batch pipeline compilation time in milliseconds; undefined until completed. */
  pipelineCompilationTimeMs?: number;
  /** Total batch preparation time in milliseconds; undefined until completed. */
  totalTimeMs?: number;
  /** Failure message; undefined without a compilation error. */
  error?: string;
}

export interface RenderingDiagnostics {
  hdrPresentation?: {
    requested: boolean;
    active: boolean;
    /** Largest encoded RGB component sent to the HDR presentation pass. */
    peakDisplayValue?: number;
  };
  textureAtlas?: TextureAtlasStats;
  /** Latest asynchronous WebGPU shader/pipeline compilation measurement. */
  shaderCompilation?: ShaderCompilationDiagnostics;
  /** Light-selection table summary (WebGPU). */
  lightSampling?: {
    emissiveTriangles: number;
    activeChoices: number;
    totalWeight: number;
    domains: Record<
      'environment' | 'infinite' | 'localAndEmissive',
      { count: number; weight: number; pmf: number }
    >;
  };
  /** Traversal stack capacities compiled into the current WebGPU shader. */
  bvh?: {
    tlasTraversalStackSize?: number;
    blasTraversalStackSize?: number;
    /** Last static preparation statistics, excluding queue and WASM loading time. */
    lastBuild?: { geometryCount: number; bvhTimeMs: number };
  };
  gpuTraceTiming?: {
    tileTimeMs: number;
    tileTimePerSampleMs?: number;
    estimatedFullFrameTimeMs: number;
    tileCount: number;
  };
}

export const DEFAULT_BEVEL_SAMPLES = 8;
export const MIN_BEVEL_SAMPLES = 1;
export const MAX_BEVEL_SAMPLES = 32;

/** Light candidates resampled per NEE estimate by the WebGPU path tracer. */
export const DEFAULT_DIRECT_LIGHT_CANDIDATES = 4;
export const MIN_DIRECT_LIGHT_CANDIDATES = 1;
export const MAX_DIRECT_LIGHT_CANDIDATES = 16;

export function normalizeDirectLightCandidates(candidates: number) {
  if (!Number.isFinite(candidates)) return DEFAULT_DIRECT_LIGHT_CANDIDATES;
  return Math.min(
    MAX_DIRECT_LIGHT_CANDIDATES,
    Math.max(MIN_DIRECT_LIGHT_CANDIDATES, Math.round(candidates))
  );
}

export function normalizeBevelSamples(samples: number) {
  if (!Number.isFinite(samples)) return DEFAULT_BEVEL_SAMPLES;
  return Math.min(
    MAX_BEVEL_SAMPLES,
    Math.max(MIN_BEVEL_SAMPLES, Math.round(samples))
  );
}

/** Shared contract implemented by both the WebGL 2.0 and WebGPU pipelines. */
export interface RenderingPipeline {
  isFirstFrame(): boolean;
  /** Discard accumulated samples and any asynchronous denoise output. */
  restartSamples(): void;
  draw(camera: Camera, maxSamples: number): boolean;
  drawPostProcess(): void;
  /** Returns true when scene geometry, materials, or instance transforms changed. */
  setMeshes(meshes: Mesh[], update?: {
    transforms?: readonly Mesh[];
    geometries?: readonly Geometry[];
    materials?: readonly OpenPBRMaterial[];
  }): boolean;
  /** Changes the software memory guard used when packing material textures. */
  setTextureAtlasBudget(maxBytes: number): boolean;
  getDebugBVHData(): Promise<{
    buffer: ArrayBuffer;
  }>;
  setAllowsMultipleSamplesPerFrame(allow: boolean): void;
  /** Configure deterministic headless batches used by offline frame export. */
  setOfflineRenderOptions(options: {
    samplesPerBatch: number;
    deferPostProcess: boolean;
    sampleSequenceOffset: number;
  }): void;
  /** Store luminance second moments in the normal output during a pilot pass. */
  setVarianceMoments(enabled: boolean): void;
  /** Skip pixels once their independent final-pass target has been reached. */
  setAdaptiveSamplingTargets(targets?: {
    width: number;
    height: number;
    data: Float32Array;
  }): void;
  /** Generate final sample targets on GPU; WebGL returns undefined. */
  prepareOfflineAdaptiveSampling(
    options: OfflineAdaptiveSamplingOptions
  ): Promise<OfflineAdaptiveSamplingResult | undefined>;
  setLights(lights: SceneLight[]): void;
  setBackground(background?: SceneBackground): void;
  /** Enables extended-range float canvas presentation when the host supports it. */
  setHDROutputEnabled?(enabled: boolean): boolean;
  setToneMappingParams(params: ToneMappingParams): boolean;
  setSize(width: number, height: number): void;
  /** Scene edits share the camera's preview/idle lifecycle when enabled. */
  needsRestartSample(camera: Camera, sceneChanged?: boolean): boolean;
  /** Returns whether the pipeline is currently rendering an interactive preview. */
  isPreviewMode(): boolean;
  /** While-converging OIDN denoises preview frames, so their cost also bounds the preview scale. */
  setOIDNPreviewActive?(active: boolean): void;
  /**
   * Denoises the current image with an OIDN network (WebGPU only) or the
   * built-in JNLM filter. Resolves whether the result is now displayed.
   */
  performOIDNDenoise?(
    denoiser: unknown,
    alphaDenoiser?: unknown,
    whileConverging?: boolean
  ): Promise<boolean>;
  /** Drops a denoise in flight; the next draw invalidates its output. */
  cancelOIDNDenoise?(): void;
  /** Keep the last completed OIDN image visible while static while-converging batches accumulate. */
  setPreserveOIDNOutput?(preserve: boolean): void;
  /** Keep the captured preview transition visible until the first settled OIDN output. */
  setPreviewTransitionDenoisePending?(pending: boolean): void;
  setBouncesAndClamping(bounces: number, clamping: number): boolean;
  /** Sets the WebGPU path tracer's per-vertex light RIS budget. */
  setDirectLightCandidates?(candidates: number): boolean;
  /** Selects WebGPU primary-ray handling for glTF BLEND materials. */
  setAlphaBlendStrategy?(strategy: AlphaBlendStrategy): boolean;
  setBevelSamples(samples: number): boolean;
  setSamplingPattern(pattern: SamplingPattern, maxSamples: number, sequenceSeed?: number): boolean;
  getTotalSamplesRendered(): number;
  getDiagnostics(): RenderingDiagnostics;
  /** Waits for asynchronous timestamp diagnostics without changing samples. */
  flushDiagnostics(): Promise<void>;
  setShadowCatcherParams(color: ColorRGB, alpha: number): boolean;
  setBloomParams(opts: {
    intensity: number;
    threshold: number;
    radius: number;
  }): boolean;
  setOnSampleRendered(
    cb: (sampleCount: number, isFirstFrame: boolean, frameTime: number) => void
  ): void;
  setMaxTimePerTile(time: number): void;
  setMaxTiles(maxTiles: number): void;
  setPreviewTargetFrameMs(time: number): void;
  setPreviewParams(params: {
    enabled: boolean;
    resolutionScale: number;
    bounces: number;
    idleDelayMs: number;
  }): void;
  setTransmissiveOutputAlphaMin(alphaMin: number): boolean;
  setOutput(output: RenderOutput): boolean;
  dispose(): void;
  readDepthSamples(area: DepthSampleArea): Promise<Float32Array | undefined>;
  readOutput(kind: 'hdr' | 'denoised' | 'albedo' | 'normal'): Promise<{
    data: Float32Array;
    width: number;
    height: number;
  }>;

}
