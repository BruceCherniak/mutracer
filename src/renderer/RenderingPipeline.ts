import Camera from '../scene/Camera';
import Mesh from '../scene/Mesh';
import Geometry from '../scene/Geometry';
import OpenPBRMaterial from '../scene/OpenPBRMaterial';
import { Scene, SceneBackground, SceneLight } from '../scene/Scene';
import { ColorRGB } from '../types';
import { TextureAtlasStats } from './MergedMaterialData';
import type {
  OfflineAdaptiveSamplingOptions,
  OfflineAdaptiveSamplingResult
} from './OfflineAdaptiveSampling';

export type ToneMapping =
  | 'agx'
  | 'aces'
  | 'cineon'
  | 'reinhard'
  | 'linear'
  | 'neutral';

export interface ToneMappingParams {
  exposure?: number;
  /** GPU histogram exposure. WebGPU only. */
  autoExposure?: boolean;
  toneMapping?: ToneMapping;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
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

export interface ShaderModuleCompilationDiagnostics {
  label: string;
  sourceBytes: number;
  sourceLines: number;
  /** Stable source-level fingerprint for diagnosing cache-key churn. */
  sourceFingerprint: string;
}

export interface ShaderPipelineCompilationDiagnostics {
  label: string;
  entryPoint: string;
  /**
   * Whether this pipeline belongs to the minimum set needed to present a
   * usable first image. Optional reuse and quality stages are false even
   * while the current eager compiler still waits for them.
   */
  firstFrameRequired: boolean;
  status: 'queued' | 'compiling' | 'ready' | 'failed';
  /** Milliseconds from the start of this pipeline compilation batch. */
  startedAtMs?: number;
  /** Milliseconds from the start of this pipeline compilation batch. */
  endedAtMs?: number;
  durationMs?: number;
  concurrentCompilationCount?: number;
  error?: string;
}

export interface ShaderCompilationDiagnostics {
  status: 'compiling' | 'ready' | 'failed';
  sourceBytes: number;
  sourceLines: number;
  pipelineCount: number;
  completedPipelineCount: number;
  sourceGenerationTimeMs: number;
  moduleCreationTimeMs: number;
  modules: ShaderModuleCompilationDiagnostics[];
  pipelines: ShaderPipelineCompilationDiagnostics[];
  /** Configured pool size, capped to the number of pipelines in this batch. */
  maximumConcurrentPipelineCount: number;
  /** Largest number of createComputePipelineAsync calls active at once. */
  peakConcurrentPipelineCount: number;
  pipelineCompilationTimeMs?: number;
  totalTimeMs?: number;
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

/** One independent 2D stratum supplies the axis and disk samples per probe. */
export function makeBevelSamplingDimensions(samples: number) {
  return Array.from({ length: normalizeBevelSamples(samples) }, () => 2);
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
  isPreviewMode?(): boolean;
  /** Keep the last completed OIDN image visible while static realtime batches accumulate. */
  setPreserveOIDNOutput?(preserve: boolean): void;
  /** Keep the captured preview transition visible until the first settled OIDN output. */
  setPreviewTransitionDenoisePending?(pending: boolean): void;
  setBouncesAndClamping(bounces: number, clamping: number): boolean;
  /** Sets the WebGPU path tracer's per-vertex light RIS budget. */
  setDirectLightCandidates?(candidates: number): boolean;
  /** Selects WebGPU primary-ray handling for glTF BLEND materials. */
  setAlphaBlendStrategy?(strategy: AlphaBlendStrategy): boolean;
  setBevelSamples(samples: number): boolean;
  setStratifiedSampling(enabled: boolean): boolean;
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
  setMaxTimePreview(time: number): void;
  setInteractivePreviewParams(params: {
    enabled: boolean;
    resolutionScale: number;
    bounces: number;
    idleDelayMs: number;
  }): void;
  setTransmissiveOutputAlphaMin(alphaMin: number): boolean;
  setOutput(output: RenderOutput): boolean;
  setOverlay(overlay: Scene['overlay']): boolean;
  dispose(): void;
  getRawOutput(): Promise<{
    data: Float32Array;
    flipY: boolean;
    width: number;
    height: number;
  }>;

}
