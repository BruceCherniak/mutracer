import Camera from './scene/Camera.js';
import { cameraSnapshot } from './renderer/cameraSnapshot.js';
import type { Scene } from './scene/Scene.js';
import type Mesh from './scene/Mesh.js';
import type Geometry from './scene/Geometry.js';
import Display from './Display.js';
import type Render from './Render.js';
import { Events } from './util/events.js';
import { SceneChangeDetector, snapshotFields, snapshotsEqual } from './renderer/sceneChangeDetector.js';
import { CommittedScene } from './renderer/committedScene.js';
import { validateSceneLights } from './renderer/lightsUtil.js';
import { ensureMeshGeometryAttributes, meshNeedsStaticBvh, getPreparedMeshGeometry } from './renderer/prepareMeshBVH.js';
import { getGeometryBvh, type BvhBuildConfig } from './renderer/geometryBvh.js';
import { prepareStaticBvhs } from './renderer/staticBvhPreparation.js';
import { canUseBvhWorker, BvhWorkerPool, resolveBvhWorkerCount } from './renderer/bvhWorkerClient.js';
import { DEFAULT_MAX_TEXTURE_ARRAY_BYTES } from './renderer/MergedMaterialData.js';
import { packDepthSampleArea, type DepthSampleArea } from './renderer/depthQuery.js';
import { makeWGPURenderTargets } from './renderer/WGPURenderingPipeline.js';
import { makeWebGLRenderTargets } from './renderer/WebGLRenderingPipeline.js';
import { WebGLDevice as WebGLRenderer } from './renderer/webgl.js';
import type { RenderPipeline, RenderTarget } from './renderer/renderPipeline.js';
import type { RenderingDiagnostics } from './renderer/RenderingPipeline.js';
import type { TinyBvhLayout } from './tinybvh/TinyBvhBuilder.js';
import type { OIDNDenoiser } from './oidn.js';
import type { JNLMDenoiser } from './renderer/jnlm.js';
import { isJNLMDenoiser } from './renderer/jnlm.js';
export type { DepthSampleArea } from './renderer/depthQuery.js';

/** BLAS implementation; default builtin. */
export type BVHBuilder = 'tinybvh' | 'builtin';
/** Optional CPU preparation settings. */
export interface PrepareOptions {
  /** Completed BLAS fraction 0–1. Default undefined. */ onProgress?: (progress: number) => void;
  /** Cancels preparation. Default undefined. */ signal?: AbortSignal;
}
/** Engine construction settings. */
export interface EngineParams {
  /** Default display canvas. Default a newly created canvas. */ canvas?: HTMLCanvasElement;
  /** Backend selection. Default auto, with WebGL fallback. webgpu requires WebGPU. */ backend?: 'auto' | 'webgpu' | 'webgl';
  /** Warn about unmarked material edits. Default true in development, false in production. */ validateUpdates?: boolean;
}
/** Material-atlas device limits. */
export interface TextureAtlasLimits { maxTextureArrayLayers: number; maxTextureDimension2D: number; }
/** Initialization result. */
export interface EngineInfo {
  backend: 'webgpu' | 'webgl'; adapterName: string; webgpuFallbackReason?: string; limits: TextureAtlasLimits;
}
/** Device and target diagnostics; Per-target GPU bytes exclude shared scene, temporary passes and driver costs. */
export interface EngineDiagnostics extends RenderingDiagnostics {
  backend: 'webgpu' | 'webgl' | undefined; adapterName: string;
  width: number; height: number; lastError?: string; webgpuFallbackReason?: string;
}
interface EngineEvents {
  progress: { stage: 'device' | 'bvh' | 'shaders'; progress: number };
  error: Error;
  devicelost: { reason: string; recovering: boolean };
}
declare const process: { env: { NODE_ENV?: string } };
function isDevelopment() { try { return process.env.NODE_ENV !== 'production'; } catch { return false; } }
let globalGPUDevice: GPUDevice | null = null;
let globalGPUAdapter: GPUAdapter | null = null;
let globalGPUAdapterInfo: GPUAdapterInfo | null = null;

/** Shared device, committed scene/camera, CPU preparation and denoiser ownership. */
export default class Engine {
  /** Source scene, accepted only by update(). Default undefined. */ scene: Scene | undefined;
  /** Source camera, accepted only by update(). Default undefined. */ camera: Camera | undefined;
  /** Default canvas and display settings. */ readonly display: Display;
  /** Static BLAS builder. Default builtin. */ bvhBuilder: BVHBuilder = 'builtin';
  /** Static BLAS layout. Default bvh2; dynamic geometry uses bvh2. */ bvhLayout: TinyBvhLayout = 'bvh2';
  /** Enable TinyBVH spatial splits. Default false. */ bvhSpatialSplits = false;
  /** Material texture budget in bytes. Default 384 MiB. */ textureAtlasBudgetBytes = DEFAULT_MAX_TEXTURE_ARRAY_BYTES;
  /** Maximum CPU BVH workers. Default auto (hardware concurrency minus one, clamped 1–4). */
  get bvhWorkerCount(): number | 'auto' { return this._bvhWorkerCount; }
  set bvhWorkerCount(count: number | 'auto') { resolveBvhWorkerCount(count); this._bvhWorkerCount = count; }
  private _bvhWorkerCount: number | 'auto' = 'auto';
  private _bvhWorkerPool?: BvhWorkerPool;
  private _bvhPreparationRevision = 0;
  private _bvhPreparation?: Promise<void>;
  private _bvhPreparationTail: Promise<unknown> = Promise.resolve();
  private _tinyBvhUnavailable = false;
  private _bvhWorkerUnavailable = false;
  private _bvhPreparedGeometry = new WeakMap<Mesh, [Geometry, number]>();
  private _lastBvhBuild?: { geometryCount: number; bvhTimeMs: number };
  private _lastBvhSettings = '';
  private _lastBudget = -1;
  private _shaderProgress = '';
  private _events = new Events<EngineEvents>();
  private _pipeline?: RenderPipeline;
  private _webglRenderer?: WebGLRenderer;
  private _gpuDevice?: GPUDevice;
  private _gpuAdapterInfo?: GPUAdapterInfo;
  private _backendChoice: NonNullable<EngineParams['backend']>;
  private _initPromise?: Promise<EngineInfo>;
  private _info?: EngineInfo;
  private _pipelineInitError?: Error;
  private _webgpuFallbackReason?: string;
  private _reportedErrors = new WeakSet<Error>();
  private _loggedErrorMessages = new Set<string>();
  private _sceneChangeDetector: SceneChangeDetector;
  private _snapshot = new CommittedScene();
  private _sourceScene?: Scene;
  private _committedScene?: Scene;
  private _sourceCamera?: Camera;
  private _committedCamera?: Camera;
  private _cameraFields: unknown[] = [];
  private _sceneRevision = 0;
  private _cameraRevision = 0;
  private _uploadedRevision = -1;
  private _pendingMeshes: 'none' | 'incremental' | 'full' = 'full';
  private _pendingTransforms = new Set<Mesh>();
  private _pendingGeometries = new Set<Geometry>();
  private _pendingMaterials = new Set<import('./scene/OpenPBRMaterial.js').default>();
  private _pendingLights = true;
  private _pendingBackground = true;
  private _disposed = false;
  private _readingDepth = false;
  private _renders = new Set<Render>();
  private _targetCounter = 0;
  private _presented?: RenderTarget;
  private _denoisers = new Set<OIDNDenoiser | JNLMDenoiser>();
  private _denoiserCache = new Map<string, {references: number; value?: OIDNDenoiser | JNLMDenoiser; pending?: Promise<OIDNDenoiser | JNLMDenoiser>}>();
  private _denoiserEntries = new WeakMap<OIDNDenoiser | JNLMDenoiser, {key: string; references: number; value?: OIDNDenoiser | JNLMDenoiser; pending?: Promise<OIDNDenoiser | JNLMDenoiser>}>();
  private _weights = new Map<string, Promise<ArrayBuffer>>();
  private _denoiseTail: Promise<unknown> = Promise.resolve();
  private _lastError: Error | undefined;
  /** Most recent synchronous engine/render failure. Default undefined. */
  get lastError() { return this._lastError; }
  /** @internal */ _setRenderError(error?: Error) { this._lastError = error; }

  constructor(params: EngineParams = {}) {
    this._backendChoice = params.backend ?? 'auto';
    this._sceneChangeDetector = new SceneChangeDetector(params.validateUpdates ?? isDevelopment());
    this.display = Display._create(this, params.canvas ?? document.createElement('canvas'));
  }
  /** Initializes once; concurrent/repeated calls share the result. */
  init(): Promise<EngineInfo> {
    return this._initPromise ??= (async () => {
      if (this._disposed) throw new Error('Engine is disposed.');
      await this._initPipeline(this._backendChoice !== 'webgl');
      if (this._pipelineInitError) throw this._pipelineInitError;
      if (this._disposed) { this._pipeline?.dispose(); throw new Error('Engine is disposed.'); }
      const gl = this._webglRenderer?.gl, limits = this._gpuDevice?.limits;
      this._info = { backend: this._gpuDevice ? 'webgpu' : 'webgl', adapterName: this._adapterName(), webgpuFallbackReason: this._webgpuFallbackReason,
        limits: { maxTextureArrayLayers: limits?.maxTextureArrayLayers ?? gl?.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS), maxTextureDimension2D: limits?.maxTextureDimension2D ?? gl?.getParameter(gl.MAX_TEXTURE_SIZE) } };
      this._upload();
      return this._info;
    })();
  }
  /** Initialization info. Default undefined until init resolves. */ get info() { return this._info; }
  /** Active backend. Default undefined until initialization completes. */ get backend() { return this._info?.backend; }
  /** GPU device. Default undefined before initialization and on WebGL. */ get device() { return this._gpuDevice; }
  /** Subscribes to shared progress/errors/device loss; returns unsubscribe. */
  on<K extends keyof EngineEvents>(event: K, listener: (value: EngineEvents[K]) => void): () => void { return this._events.on(event, listener); }

  /** The sole external edit detection/commit point. Returns whether inputs changed. */
  update(): boolean {
    if (this._disposed) throw new Error('Engine is disposed.');
    this._lastError = undefined;
    let changed = false;
    const cameraFields = this.camera ? snapshotFields(this.camera) : [];
    if (this.camera !== this._sourceCamera || !snapshotsEqual(cameraFields, this._cameraFields)) {
      this._sourceCamera = this.camera; this._cameraFields = cameraFields;
      this._committedCamera = this.camera ? cameraSnapshot(this.camera) : undefined; this._cameraRevision++; changed = true;
    }
    const bvhSettings = `${this.bvhBuilder}/${this.bvhLayout}/${this.bvhSpatialSplits}`;
    const force = bvhSettings !== this._lastBvhSettings || this.textureAtlasBudgetBytes !== this._lastBudget;
    if (this.scene !== this._sourceScene || force) this._sceneChangeDetector.reset();
    if (this.scene) {
      validateSceneLights(this.scene.lights, error => this._notifyError(error));
      ensureMeshGeometryAttributes(this.scene.meshes);
      const changes = this._sceneChangeDetector.detect(this.scene);
      if (changes.meshes !== 'none' || changes.lights || changes.background || this.scene !== this._sourceScene || force) {
        this._committedScene = this._snapshot.capture(this.scene, changes);
        if (changes.meshes === 'full' || force || this.scene !== this._sourceScene) this._pendingMeshes = 'full';
        else if (changes.meshes === 'incremental' && this._pendingMeshes !== 'full') this._pendingMeshes = 'incremental';
        for (const mesh of changes.transforms) this._pendingTransforms.add(this._snapshot.mirror(mesh));
        for (const geometry of changes.geometries) this._pendingGeometries.add(this._snapshot.mirror(geometry));
        for (const material of changes.materials) this._pendingMaterials.add(this._snapshot.mirror(material));
        this._pendingLights ||= changes.lights;
        this._pendingBackground ||= changes.background;
        this._sceneRevision++; changed = true;
      }
      this._sceneChangeDetector.commit();
    } else if (this._sourceScene) { this._committedScene = undefined; this._pendingMeshes = 'full'; this._pendingLights = true; this._pendingBackground = true; this._sceneRevision++; changed = true; }
    this._sourceScene = this.scene; this._lastBvhSettings = bvhSettings; this._lastBudget = this.textureAtlasBudgetBytes;
    if (!this._pipeline) void this.init().catch(() => {});
    if (changed) for (const render of this._renders) render._inputsChanged();
    this._upload();
    return changed;
  }
  private _upload() {
    const pipeline = this._pipeline;
    if (!pipeline || this._disposed || this._bvhPreparation || this._uploadedRevision === this._sceneRevision) return;
    const scene = this._committedScene ?? { meshes: [], lights: [] };
    if (this._needsBVHPreparation(scene.meshes)) {
      const task = this.prepare(scene); this._bvhPreparation = task;
      void task.then(() => { if (this._bvhPreparation === task) this._bvhPreparation = undefined; this._upload(); }, error => { if (this._bvhPreparation === task) this._bvhPreparation = undefined; this._notifyError(error); });
      return;
    }
    const budgetChanged = pipeline.setTextureAtlasBudget(this._lastBudget >= 0 ? this._lastBudget : this.textureAtlasBudgetBytes);
    if (this._pendingMeshes !== 'none' || budgetChanged) pipeline.setMeshes(scene.meshes, this._pendingMeshes === 'full' || budgetChanged ? undefined : {
      transforms: [...this._pendingTransforms], geometries: [...this._pendingGeometries], materials: [...this._pendingMaterials]
    });
    if (this._pendingLights) pipeline.setLights(scene.lights);
    if (this._pendingBackground) pipeline.setBackground(scene.background);
    this._pendingMeshes = 'none'; this._pendingLights = false; this._pendingBackground = false;
    this._pendingTransforms.clear(); this._pendingGeometries.clear(); this._pendingMaterials.clear();
    this._uploadedRevision = this._sceneRevision;
  }
  private _bvhConfig(): BvhBuildConfig { return {builder: this.bvhBuilder, layout: this.bvhLayout, spatialSplits: this.bvhSpatialSplits}; }
  /** Builds static CPU BVHs for this scene without replacing GPU inputs. Options default undefined. */
  prepare(scene: Scene, options: PrepareOptions = {}): Promise<void> {
    const revision = this._bvhPreparationRevision;
    const preparation = this._bvhPreparationTail.then(async () => {
      const isCancelled = () => revision !== this._bvhPreparationRevision || options.signal?.aborted === true;
      if (isCancelled()) return;
      const meshes = scene.meshes;
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
          if (this._bvhPreparation === preparation) this._events.emit('progress', {stage: 'bvh', progress});
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

  private async _initPipeline(preferWebGPU: boolean) {
    let gpuCreated = false;
    try {

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
          this._pipeline = makeWGPURenderTargets(this.display.canvas, gpuDevice, {
            presentationFormat: gpu.getPreferredCanvasFormat()
          });
          gpuCreated = true;
        } catch (e) {
          if (this._backendChoice === 'webgpu') throw e;
          this._webgpuFallbackReason = e instanceof Error ? e.message : String(e);
          this._gpuDevice = undefined;
          this._gpuAdapterInfo = undefined;
        }
      }
      if (!gpuCreated) {
        if (this._backendChoice === 'webgpu') throw new Error('WebGPU is not available in this environment');
        if (preferWebGPU && !this._webgpuFallbackReason) {
          this._webgpuFallbackReason = 'WebGPU is not available in this environment';
        }
        this._webglRenderer = new WebGLRenderer({
          canvas: this.display.canvas,
          alpha: true,
          depth: true,
          stencil: false,
          antialias: false,
          pixelRatio: 1,
          preserveDrawingBuffer: true,
          // PENDING
          premultipliedAlpha: false,
          parallelShaderCompile: true,
          powerPreference: 'high-performance'
        });

        this._pipeline = makeWebGLRenderTargets(this._webglRenderer);
      }


    } catch (error) {
      this._pipelineInitError = error instanceof Error ? error : new Error(String(error));
      this._notifyError(this._pipelineInitError);
    } finally {

      this._events.emit('progress', {stage: 'device', progress: 1});
    }
  }

  private _adapterName() {
    if (this._gpuAdapterInfo) return this._gpuAdapterInfo.description || this._gpuAdapterInfo.vendor || 'WebGPU';
    const gl = this._webglRenderer?.gl, extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension && gl ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : this._webglRenderer ? 'WebGL 2' : '';
  }
  /** @internal */ _reportShaderProgress() {
    const compilation = this._pipeline?.getDiagnostics().shaderCompilation;
    if (!compilation) return;
    const key = `${compilation.status}/${compilation.completedPipelineCount}/${compilation.pipelineCount}`;
    if (key === this._shaderProgress) return;
    this._shaderProgress = key;
    this._events.emit('progress', {stage: 'shaders', progress: compilation.pipelineCount ? compilation.completedPipelineCount / compilation.pipelineCount : 1});
  }
  /** Current shared preparation and resident target statistics. Default undefined before any work. */
  getDiagnostics(): EngineDiagnostics | undefined {
    if (!this._pipeline && !this._lastBvhBuild) return;
    const values = this._pipeline?.getDiagnostics();
    return { ...values, bvh: {...values?.bvh, lastBuild: this._lastBvhBuild}, backend: this.backend, adapterName: this._adapterName(), width: this.display.canvas.width, height: this.display.canvas.height,
      lastError: this.lastError?.message, webgpuFallbackReason: this._webgpuFallbackReason,
      presentedTarget: this._presented?.label, presentedComplete: this._presented?.presentationComplete ?? false };
  }
  /** Queries a 7×7 depth grid using the committed engine camera. Default undefined until GPU data is ready. */
  async readDepthSamples(area: DepthSampleArea): Promise<Float32Array | undefined> {
    packDepthSampleArea(area, 1);
    if (!this._ready || !this._committedCamera || this._readingDepth) return;
    this._readingDepth = true;
    try {
      const camera = cameraSnapshot(this._committedCamera);
      camera.aspect ??= this.display.canvas.width / this.display.canvas.height;
      const result = await this._pipeline!.readDepthSamples(camera, area);
      return this._disposed ? undefined : result;
    }
    finally { this._readingDepth = false; }
  }
  /** Releases all renders, shared resources, CPU workers and owned denoisers. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true; this._bvhPreparationRevision++;
    for (const render of [...this._renders]) render.dispose();
    this._pipeline?.dispose(); this._pipeline = undefined; this._webglRenderer?.dispose(); this._bvhWorkerPool?.dispose();
    for (const denoiser of [...this._denoisers]) { const entry = this._denoiserEntries.get(denoiser); if (entry) entry.references = 1; this._releaseDenoiser(denoiser); }
    this._denoiserCache.clear();
    this._weights.clear(); this._events.clear();
  }
  /** @internal */ get _initializationError() { return this._pipelineInitError; }
  /** @internal */ get _ready() { return !!this._pipeline && this._uploadedRevision === this._sceneRevision && !!this._committedScene && !!this._committedCamera && !this._disposed; }
  /** @internal */ get _inputs() { return {scene: this._sceneRevision, camera: this._cameraRevision, value: this._committedCamera}; }
  /** @internal */ _register(render: Render) { if (this._disposed) throw new Error('Engine is disposed.'); this._renders.add(render); }
  /** @internal */ _unregister(render: Render) { this._renders.delete(render); }
  /** @internal */ _createTarget() { return this._pipeline?.createTarget(`render-${++this._targetCounter}`); }
  /** @internal */ _releaseTarget(target: RenderTarget) { if (this._presented === target) this._presented = undefined; this._pipeline?.releaseTarget(target); }
  /** @internal */ _present(target: RenderTarget) { target.activate(); target.present(); this._presented = target; }
  /** @internal */ _notifyError(value: unknown): Error {
    const error = value instanceof Error ? value : new Error(String(value));
    if (!this._loggedErrorMessages.has(error.message)) { this._loggedErrorMessages.add(error.message); console.error(`Path tracing failed: ${error.message}`, error); }
    if (!this._reportedErrors.has(error)) { this._reportedErrors.add(error); this._events.emit('error', error); }
    return error;
  }
  /** @internal */ _getWeights(url: string, load: () => Promise<ArrayBuffer>) {
    let pending = this._weights.get(url);
    if (!pending) { pending = load(); this._weights.set(url, pending); void pending.catch(() => { if (this._weights.get(url) === pending) this._weights.delete(url); }); }
    return pending;
  }
  /** @internal */ _retainDenoiser<T extends OIDNDenoiser | JNLMDenoiser>(key: string, create: () => T): T {
    let entry = this._denoiserCache.get(key);
    if (!entry?.value) {
      const value = this._ownDenoiser(create());
      const next = {key, references: 0, value};
      this._denoiserCache.set(key, next); this._denoiserEntries.set(value, next); entry = next;
    }
    entry.references++; return entry.value as T;
  }
  /** @internal */ async _acquireDenoiser(key: string, create: () => Promise<OIDNDenoiser>): Promise<OIDNDenoiser> {
    let entry = this._denoiserCache.get(key);
    if (!entry) {
      const next: {key: string; references: number; value?: OIDNDenoiser | JNLMDenoiser; pending?: Promise<OIDNDenoiser | JNLMDenoiser>} = {key, references: 0};
      next.pending = create().then(filter => { next.value = this._ownDenoiser(filter); this._denoiserEntries.set(filter, next); return filter; });
      this._denoiserCache.set(key, next); entry = next;
    }
    entry.references++;
    try { return (entry.value ?? await entry.pending!) as OIDNDenoiser; }
    catch (error) { entry.references--; if (this._denoiserCache.get(key) === entry) this._denoiserCache.delete(key); throw error; }
  }
  /** @internal */ _ownDenoiser<T extends OIDNDenoiser | JNLMDenoiser>(denoiser: T): T {
    if (this._disposed) { this._disposeDenoiser(denoiser); throw new Error('Engine is disposed.'); }
    this._denoisers.add(denoiser); return denoiser;
  }
  /** @internal */ _releaseDenoiser(denoiser: OIDNDenoiser | JNLMDenoiser) {
    const entry = this._denoiserEntries.get(denoiser);
    if (entry && --entry.references > 0) return;
    if (entry && this._denoiserCache.get(entry.key) === entry) this._denoiserCache.delete(entry.key);
    this._denoiserEntries.delete(denoiser);
    if (!this._denoisers.delete(denoiser)) return;
    this._disposeDenoiser(denoiser);
  }
  private _disposeDenoiser(denoiser: OIDNDenoiser | JNLMDenoiser) {
    if (!isJNLMDenoiser(denoiser)) { denoiser.auxiliaryDenoisers?.albedo.dispose(); denoiser.auxiliaryDenoisers?.normal.dispose(); }
    denoiser.dispose();
  }
  /** @internal */ _enqueueDenoise<T>(work: () => Promise<T>): Promise<T> {
    const task = this._denoiseTail.then(work); this._denoiseTail = task.catch(() => {}); return task;
  }
}
