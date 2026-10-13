import type {DenoiserHandle, OIDNWeb} from './denoiser.js';
import type {DenoiseSchedule} from '../Render.js';
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

export type DisplayChannel =
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

/** Compilation measurements for one shader pipeline/program. */
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
  /** Label of the last complete target presented; undefined before the first image. */
  presentedTarget?: string;
  /** Whether the displayed target contains a complete image. Default false. */
  presentedComplete?: boolean;
  /** Resident target dimensions and allocated GPU bytes, including denoise resources. */
  targets?: { label: string; width: number; height: number; bytes: number }[];
  hdrPresentation?: {
    requested: boolean;
    active: boolean;
    /** Largest encoded RGB component sent to the HDR presentation pass. */
    peakDisplayValue?: number;
  };
  textureAtlas?: TextureAtlasStats;
  /** Shader compilation measurements: current WebGPU batch or cumulative WebGL programs. */
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
/** Shared scene resources; uploaded once per committed revision. */
export interface SceneResources {
  /** Returns true when scene geometry, materials, or instance transforms changed. */
  setMeshes(meshes: Mesh[], update?: {
    transforms?: readonly Mesh[];
    geometries?: readonly Geometry[];
    materials?: readonly OpenPBRMaterial[];
  }): boolean;
  /** Changes the software memory guard used when packing material textures. */
  setTextureAtlasBudget(maxBytes: number): boolean;
  setLights(lights: SceneLight[]): void;
  setBackground(background?: SceneBackground): void;
  getDiagnostics(): RenderingDiagnostics;
  dispose(): void;
  readDepthSamples(area: DepthSampleArea): Promise<Float32Array | undefined>;
}
/** Explicit execution and composition for one accumulation. */
export interface RenderPasses {
  isFirstFrame(): boolean;
  /** Discard accumulated samples and any asynchronous denoise output. */
  restartSamples(): void;
  trace(camera: Camera, maxSamples: number): boolean;
  drawPostProcess(): void;
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
  /** Enables extended-range float canvas presentation when the host supports it. */
  setHDROutputEnabled?(enabled: boolean): boolean;
  setToneMappingParams(params: ToneMappingParams): boolean;
  setSize(width: number, height: number): void;
  /**
   * Denoises the current image with an explicitly selected built-in or custom filter. Resolves whether the result is now displayed.
   */
  performDenoise?(
    denoiser: DenoiserHandle,
    alphaDenoiser?: OIDNWeb,
    schedule?: DenoiseSchedule,
    signal?: AbortSignal
  ): Promise<boolean>;
  /** Drops a denoise in flight; the next draw invalidates its output. */
  cancelDenoise?(): void;
  /** Keep the last completed OIDN image visible while static while-converging batches accumulate. */
  setPreserveDenoisedOutput?(preserve: boolean): void;
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
  setOutput(output: DisplayChannel): boolean;
  dispose(): void;
  readOutput(kind: 'hdr' | 'denoised' | 'albedo' | 'normal'): Promise<{
    data: Float32Array;
    width: number;
    height: number;
  }>;
}
