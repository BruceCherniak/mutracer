import * as bvhWorker from '../../src/renderer/bvhWorkerClient';
import { buildBLAS } from '../../src/renderer/bvhAccel';
import { updateMeshInstances } from '../../src/renderer/prepareMeshBVH';
import { ensureMeshGeometryAttributes } from '../../src/renderer/prepareMeshBVH';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Renderer from '../../src/Renderer';
import { DEFAULT_MAX_TEXTURE_ARRAY_BYTES } from '../../src/renderer/MergedMaterialData';
import type { RenderingPipeline } from '../../src/renderer/RenderingPipeline';
import type { WGPURenderingPipeline } from '../../src/renderer/WGPURenderingPipeline';
import type Camera from '../../src/scene/Camera';
import Mesh from '../../src/scene/Mesh';
import { createCubeGeometry } from '../../src/main';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import type { Scene } from '../../src/scene/Scene';

type DenoiseMode = { whileConverging?: boolean; sampleInterval?: number; coalesceSceneUpdates?: boolean };
/**
 * Applies what `setDenoiser()` sets once its network has loaded. Transition
 * tests use fixed 8-sample batches unless they pass `sampleInterval`.
 */
function setDenoiseMode(renderer: Renderer, mode: DenoiseMode) {
  (renderer as unknown as { _setDenoiseMode(mode: DenoiseMode): void })._setDenoiseMode(
    'sampleInterval' in mode ? mode : { sampleInterval: 8, ...mode }
  );
}

function createPipeline(overrides: Partial<WGPURenderingPipeline> = {}) {
  let samples = 1;
  const pipeline = {
    isFirstFrame: vi.fn(() => false),
    restartSamples: vi.fn(),
    draw: vi.fn((_camera: Camera, maxSamples: number) => {
      samples = Math.max(samples, maxSamples);
      return false;
    }),
    drawPostProcess: vi.fn(),
    setMeshes: vi.fn(() => false),
    setTextureAtlasBudget: vi.fn(() => false),
    getDebugBVHData: vi.fn(),
    setAllowsMultipleSamplesPerFrame: vi.fn(),
    setOfflineRenderOptions: vi.fn(),
    setPreserveOIDNOutput: vi.fn(),
    setPreviewTransitionDenoisePending: vi.fn(),
    setVarianceMoments: vi.fn(),
    setAdaptiveSamplingTargets: vi.fn(),
    prepareOfflineAdaptiveSampling: vi.fn(async () => undefined),
    setLights: vi.fn(),
    setBackground: vi.fn(),
    setHDROutputEnabled: vi.fn(() => false),
    setToneMappingParams: vi.fn(() => false),
    setSize: vi.fn(),
    needsRestartSample: vi.fn(() => true),
    setBouncesAndClamping: vi.fn(() => false),
    setBevelSamples: vi.fn(() => false),
    setSamplingPattern: vi.fn(() => false),
    getTotalSamplesRendered: vi.fn(() => samples),
    getDiagnostics: vi.fn(() => ({})),
    setShadowCatcherParams: vi.fn(() => false),
    setBloomParams: vi.fn(() => false),
    setOnSampleRendered: vi.fn(),
    setMaxTimePerTile: vi.fn(),
    setMaxTiles: vi.fn(),
    setMaxTimePreview: vi.fn(),
    setInteractivePreviewParams: vi.fn(),
    setTransmissiveOutputAlphaMin: vi.fn(() => false),
    setOutput: vi.fn(() => false),
    dispose: vi.fn(),
    getRawOutput: vi.fn(),
    performOIDNDenoise: vi.fn(() => new Promise<boolean>(() => {})),
    ...overrides
  } as RenderingPipeline & {
    performOIDNDenoise: ReturnType<typeof vi.fn>;
  };
  return pipeline;
}

function attachPipeline(renderer: Renderer, pipeline: RenderingPipeline) {
  (renderer as unknown as { _pipeline: RenderingPipeline })._pipeline =
    pipeline;
}

function markSceneStable(renderer: Renderer, scene: Scene) {
  ensureMeshGeometryAttributes(scene.meshes);
  const internal = renderer as unknown as {
    _sceneChangeDetector: SceneChangeDetector; _scenePipeline: RenderingPipeline;
    _sceneInitialized: boolean; _pipeline: RenderingPipeline; _forceMeshUpdate: boolean;
  };
  internal._sceneChangeDetector.detect(scene);
  internal._sceneChangeDetector.commit();
  internal._scenePipeline = internal._pipeline;
  internal._sceneInitialized = true;
  internal._forceMeshUpdate = true;
}

describe('Renderer sizing', () => {

  it('exposes a configurable texture-atlas budget', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });

    expect(renderer.textureAtlasBudgetBytes).toBe(
      DEFAULT_MAX_TEXTURE_ARRAY_BYTES
    );
    renderer.textureAtlasBudgetBytes = 768 * 1024 * 1024;
    expect(renderer.textureAtlasBudgetBytes).toBe(768 * 1024 * 1024);
  });

  it('does not reset the canvas drawing buffer when the size is unchanged', () => {
    let width = 1920;
    let height = 1088;
    let dimensionWrites = 0;
    const canvas = {
      get width() {
        return width;
      },
      set width(value: number) {
        dimensionWrites++;
        width = value;
      },
      get height() {
        return height;
      },
      set height(value: number) {
        dimensionWrites++;
        height = value;
      }
    } as HTMLCanvasElement;
    const renderer = new Renderer({ canvas });

    renderer.setSize(1920, 1088);
    expect(dimensionWrites).toBe(0);

    renderer.setSize(1280, 720);
    expect(dimensionWrites).toBe(2);
    expect(renderer.getSize()).toEqual({ width: 1280, height: 720 });
  });

  it('forwards direct HDR presentation to the active pipeline', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      setHDROutputEnabled: vi.fn(() => true)
    });
    const scene = { meshes: [], lights: [] } as unknown as Scene;
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.hdrOutputEnabled = true;

    renderer.render(scene, {} as Camera);

    expect(pipeline.setHDROutputEnabled).toHaveBeenCalledWith(true);
  });

  it('automatically forwards transform-only edits for one render', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    renderer.bvhBuilder = 'builtin';
    const pipeline = createPipeline();
    const mesh = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
    const scene = { meshes: [mesh], lights: [] } as unknown as Scene;
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);

    (renderer as any)._forceMeshUpdate = false;
    mesh.transform[12] = 2;
    renderer.render(scene, {} as Camera);
    renderer.render(scene, {} as Camera);

    expect(pipeline.setMeshes).toHaveBeenNthCalledWith(1, scene.meshes, { transforms: [mesh], materials: [], geometries: [] });
    expect(pipeline.setMeshes).toHaveBeenCalledTimes(1);
  });

  it('does not accept detector edits during asynchronous BVH preparation', async () => {
    const renderer = new Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    const pipeline = createPipeline();
    const mesh = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
    const scene: Scene = { meshes: [mesh], lights: [] };
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    (renderer as any)._forceMeshUpdate = false;
    mesh.materials[0].markUpdated();
    const prepare = vi.spyOn(renderer, 'prepareScene').mockResolvedValue({geometryCount: 0, bvhTimeMs: 0});
    const needsPreparation = vi.spyOn(renderer as any, '_needsBVHPreparation').mockReturnValue(true);
    expect(renderer.render(scene, {} as Camera)).toBe('preparing');
    expect(pipeline.setMeshes).not.toHaveBeenCalled();
    await (renderer as any)._bvhPreparation;
    needsPreparation.mockReturnValue(false);
    renderer.render(scene, {} as Camera);
    expect(pipeline.setMeshes).toHaveBeenCalledOnce();
    renderer.render(scene, {} as Camera);
    expect(pipeline.setMeshes).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('detects geometry, material and membership edits without explicit renderer signals', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    renderer.bvhBuilder = 'builtin';
    const pipeline = createPipeline();
    const scene = { meshes: [new Mesh(createCubeGeometry(), new OpenPBRMaterial())], lights: [] } as Scene;
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);

    renderer.render(scene, {} as Camera);
    renderer.render(scene, {} as Camera);
    expect(pipeline.setMeshes).toHaveBeenCalledTimes(1);

    scene.meshes[0].geometry.markUpdated();
    renderer.render(scene, {} as Camera);
    expect(pipeline.setMeshes).toHaveBeenCalledTimes(2);

    scene.meshes[0].materials[0].markUpdated();
    renderer.render(scene, {} as Camera);
    expect(pipeline.setMeshes).toHaveBeenCalledTimes(3);

    scene.meshes = [...scene.meshes];
    renderer.render(scene, {} as Camera);
    expect(pipeline.setMeshes).toHaveBeenCalledTimes(4);
  });

});

describe('Renderer offline frames', () => {

  it('runs deterministic fixed-spp batches without animation-frame waits', async () => {
    let samples = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      restartSamples: vi.fn(() => {
        samples = 0;
      }),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = target;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples)
    });
    const scene = { meshes: [], lights: [] } as unknown as Scene;
    const camera = {} as Camera;
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    Object.defineProperty(renderer, 'device', { value: undefined });
    vi.spyOn(renderer, 'init').mockResolvedValue({backend: 'webgpu', adapterName: 'mock', limits: {maxTextureArrayLayers: 256, maxTextureDimension2D: 8192}});

    const result = await renderer.renderOfflineFrame(scene, camera, {
      samples: 12,
      samplesPerBatch: 4,
      sampleSequenceOffset: 37
    });

    expect(result).toEqual({
      samples: 12,
      averageSamplesPerPixel: 12,
      pilotSamples: 0,
      adaptiveSampling: false
    });
    expect(pipeline.setOfflineRenderOptions).toHaveBeenCalledWith({
      samplesPerBatch: 4,
      deferPostProcess: true,
      sampleSequenceOffset: 37
    });
    expect(pipeline.setOfflineRenderOptions).toHaveBeenLastCalledWith({
      samplesPerBatch: 0,
      deferPostProcess: false,
      sampleSequenceOffset: 0
    });
  });

  it('throttles progressive final-pass canvas updates when requested', async () => {
    let samples = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      restartSamples: vi.fn(() => {
        samples = 0;
      }),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = Math.min(target, samples + 4);
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples)
    });
    const scene = { meshes: [], lights: [] } as unknown as Scene;
    const camera = {} as Camera;
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    Object.defineProperty(renderer, 'device', { value: {
        queue: { onSubmittedWorkDone: vi.fn(async () => undefined) }
      } as unknown as GPUDevice });
    vi.spyOn(renderer, 'init').mockResolvedValue({backend: 'webgpu', adapterName: 'mock', limits: {maxTextureArrayLayers: 256, maxTextureDimension2D: 8192}});

    await renderer.renderOfflineFrame(scene, camera, {
      samples: 12,
      samplesPerBatch: 4,
      previewIntervalMs: 0
    });

    expect(pipeline.drawPostProcess).toHaveBeenCalledTimes(2);
  });

  it('adapts WebGPU batch size from measured queue completion time', async () => {
    let samples = 0;
    let samplesPerBatch = 0;
    let clock = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      restartSamples: vi.fn(() => {
        samples = 0;
      }),
      setOfflineRenderOptions: vi.fn((options) => {
        samplesPerBatch = options.samplesPerBatch;
      }),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = Math.min(target, samples + samplesPerBatch);
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples)
    });
    const scene = { meshes: [], lights: [] } as unknown as Scene;
    const camera = {} as Camera;
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const queueDurations = [5, 10, 80, 20];
    Object.defineProperty(renderer, 'device', { value: {
        queue: {
          onSubmittedWorkDone: vi.fn(async () => {
            clock += queueDurations.shift() ?? 0;
          })
        }
      } as unknown as GPUDevice });
    vi.spyOn(renderer, 'init').mockResolvedValue({backend: 'webgpu', adapterName: 'mock', limits: {maxTextureArrayLayers: 256, maxTextureDimension2D: 8192}});

    await renderer.renderOfflineFrame(scene, camera, {
      samples: 9,
      samplesPerBatch: 8,
      targetBatchTimeMs: 30
    });

    expect(pipeline.setOfflineRenderOptions).toHaveBeenNthCalledWith(1, {
      samplesPerBatch: 1,
      deferPostProcess: true,
      sampleSequenceOffset: 0
    });
    expect(pipeline.setOfflineRenderOptions).toHaveBeenNthCalledWith(2, {
      samplesPerBatch: 2,
      deferPostProcess: true,
      sampleSequenceOffset: 0
    });
    expect(pipeline.setOfflineRenderOptions).toHaveBeenNthCalledWith(3, {
      samplesPerBatch: 4,
      deferPostProcess: true,
      sampleSequenceOffset: 0
    });
    expect(pipeline.setOfflineRenderOptions).toHaveBeenNthCalledWith(4, {
      samplesPerBatch: 2,
      deferPostProcess: true,
      sampleSequenceOffset: 0
    });
    expect(pipeline.setOfflineRenderOptions).toHaveBeenNthCalledWith(5, {
      samplesPerBatch: 0,
      deferPostProcess: false,
      sampleSequenceOffset: 0
    });
  });

  it('uses GPU-generated adaptive targets without full pilot readback', async () => {
    let samples = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const history = {
      width: 1,
      height: 1,
      tileSize: 1,
      columns: 1,
      rows: 1,
      meanLuminance: new Float32Array([0.5]),
      variance: new Float32Array([0.01]),
      sampleTargets: new Uint32Array([18])
    };
    const pipeline = createPipeline({
      restartSamples: vi.fn(() => {
        samples = 0;
      }),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = target;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      prepareOfflineAdaptiveSampling: vi.fn(async () => ({
        maximumTarget: 18,
        averageTarget: 12.5,
        history
      }))
    });
    const scene = { meshes: [], lights: [] } as unknown as Scene;
    const camera = {} as Camera;
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    Object.defineProperty(renderer, 'device', { value: {
        queue: { onSubmittedWorkDone: vi.fn(async () => undefined) }
      } as unknown as GPUDevice });
    vi.spyOn(renderer, 'init').mockResolvedValue({backend: 'webgpu', adapterName: 'mock', limits: {maxTextureArrayLayers: 256, maxTextureDimension2D: 8192}});

    const result = await renderer.renderOfflineFrame(scene, camera, {
      samples: 32,
      samplesPerBatch: 8,
      sampleSequenceOffset: 100,
      adaptiveSampling: { pilotSamples: 4, tileSize: 8 }
    });

    expect(pipeline.prepareOfflineAdaptiveSampling).toHaveBeenCalledWith({
      pilotSamples: 4,
      tileSize: 8,
      maxSamples: 32
    });
    expect(result).toEqual({
      samples: 18,
      averageSamplesPerPixel: 12.5,
      pilotSamples: 4,
      varianceHistory: history,
      adaptiveSampling: true
    });
  });
});

describe('Renderer while-converging OIDN', () => {
  it.each([true, false])('refreshes post-processing when denoising is enabled (%s)', async (enabled) => {
    const renderer = new Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    renderer.maxSamples = 8;
    renderer.interactivePreview = false;
    if (enabled) renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: false });
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => false),
      performOIDNDenoise: vi.fn(async () => true),
      getTotalSamplesRendered: vi.fn(() => 8),
      cancelOIDNDenoise: vi.fn()
    });
    const scene = { meshes: [], lights: [] } as Scene;
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    const camera = {} as Camera;
    renderer.render(scene, camera);
    await Promise.resolve();
    pipeline.performOIDNDenoise.mockClear();
    vi.mocked(pipeline.draw).mockClear();
    vi.mocked(pipeline.setToneMappingParams).mockReturnValueOnce(true);
    renderer.render(scene, camera);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(pipeline.draw).not.toHaveBeenCalled();
  });

  const scene = { meshes: [], lights: [] } as unknown as Scene;
  const camera = {} as Camera;

  it.each(['meshes', 'lights', 'background'] as const)(
    'starts a 1spp preview for %s edits without treating initial setup as an edit',
    async (changedPart) => {
      let samples = 0;
      let preview = false;
      let meshChanged = true;
      const renderer = new Renderer({
        canvas: { width: 1280, height: 720 } as HTMLCanvasElement
      });
      renderer.oidn = {} as never;
      setDenoiseMode(renderer, { whileConverging: true });
      const pipeline = createPipeline({
        setMeshes: vi.fn(() => {
          const changed = meshChanged;
          meshChanged = false;
          return changed;
        }),
        needsRestartSample: vi.fn((_camera: Camera, sceneChanged?: boolean) => {
          if (!sceneChanged) return false;
          preview = true;
          samples = 0;
          return true;
        }),
        isPreviewMode: vi.fn(() => preview),
        getTotalSamplesRendered: vi.fn(() => samples),
        draw: vi.fn((_camera: Camera, target: number) => {
          samples = target;
          return false;
        }),
        performOIDNDenoise: vi.fn(async () => true)
      });
      attachPipeline(renderer, pipeline);
      renderer.render(scene, camera);
      expect(preview).toBe(false);
      expect(pipeline.needsRestartSample).toHaveBeenLastCalledWith(camera, false);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      renderer.render(scene, camera);
      expect(pipeline.draw).toHaveBeenLastCalledWith(camera, 8);
      await new Promise<void>(resolve => setTimeout(resolve, 0));

      meshChanged = changedPart === 'meshes';
      const editedScene = {
        ...scene,
        ...(changedPart === 'meshes' ? { meshes: [...scene.meshes] } : {}),
        ...(changedPart === 'lights' ? { lights: [...scene.lights] } : {}),
        ...(changedPart === 'background' ? { background: [0.1, 0.2, 0.3] } : {})
      } as Scene;
      renderer.render(editedScene, camera);

      expect(preview).toBe(true);
      expect(pipeline.needsRestartSample).toHaveBeenLastCalledWith(camera, true);
      expect(pipeline.draw).toHaveBeenLastCalledWith(camera, 1);
      expect(pipeline.performOIDNDenoise).toHaveBeenLastCalledWith(
        renderer.oidn, undefined, true
      );
    }
  );

  it('holds the completed denoise through a material edit and its incomplete first sample', async () => {
    let samples = 20;
    let firstFrame = true;
    let compiling = true;
    let tilesRemaining = 2;
    let finishDenoise!: (completed: boolean) => void;
    const pipeline = createPipeline({
      setMeshes: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
      isFirstFrame: vi.fn(() => firstFrame),
      needsRestartSample: vi.fn(() => false),
      draw: vi.fn((_camera: Camera, target: number) => {
        if (firstFrame) samples = 0;
        if (compiling) return true;
        firstFrame = false;
        if (--tilesRemaining === 0) samples = target;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise: vi.fn(() => new Promise<boolean>((resolve) => {
        finishDenoise = resolve;
      }))
    });
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    setDenoiseMode(renderer, { whileConverging: true });
    renderer.oidn = {} as never;

    renderer.render(scene, camera);
    expect(samples).toBe(0);
    compiling = false;
    renderer.render(scene, camera);
    expect(samples).toBe(0);
    expect(pipeline.performOIDNDenoise).not.toHaveBeenCalled();
    renderer.render(scene, camera);
    expect(samples).toBe(1);
    renderer.render(scene, camera);
    expect(pipeline.draw).toHaveBeenCalledTimes(3);
    expect(pipeline.setPreserveOIDNOutput).toHaveBeenCalledTimes(4);
    for (let call = 1; call <= 4; call++) {
      expect(pipeline.setPreserveOIDNOutput).toHaveBeenNthCalledWith(call, true);
    }
    expect(pipeline.drawPostProcess).not.toHaveBeenCalled();

    finishDenoise(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pipeline.drawPostProcess).toHaveBeenCalledOnce();
    renderer.render(scene, camera);
    expect(pipeline.draw).toHaveBeenLastCalledWith(camera, 8);
  });

  it('does not hold stale OIDN output when no replacement denoiser is available', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => false)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    setDenoiseMode(renderer, { whileConverging: true });

    renderer.render(scene, camera);

    expect(pipeline.setPreserveOIDNOutput).toHaveBeenLastCalledWith(false);
  });

  it('presents the initial static 1spp denoise before accumulating eight samples', async () => {
    let samples = 0;
    let compiling = true;
    let finishDenoise!: (completed: boolean) => void;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => false),
      draw: vi.fn((_camera: Camera, target: number) => {
        if (!compiling) samples = target;
        return compiling;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise: vi.fn(() => new Promise<boolean>((resolve) => {
        finishDenoise = resolve;
      }))
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });

    renderer.render(scene, camera);
    compiling = false;
    renderer.render(scene, camera);
    expect(pipeline.draw).toHaveBeenNthCalledWith(1, camera, 1);
    expect(pipeline.draw).toHaveBeenNthCalledWith(2, camera, 1);
    expect(samples).toBe(1);
    renderer.render(scene, camera);
    expect(pipeline.draw).toHaveBeenCalledTimes(2);
    expect(pipeline.drawPostProcess).not.toHaveBeenCalled();
    finishDenoise(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pipeline.drawPostProcess).toHaveBeenCalledOnce();

    renderer.render(scene, camera);
    expect(pipeline.draw).toHaveBeenLastCalledWith(camera, 8);
    expect(pipeline.setPreserveOIDNOutput).toHaveBeenLastCalledWith(true);
  });

  it('denoises the held 1spp frame as soon as the while-converging model loads', async () => {
    let samples = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => false),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = target;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise: vi.fn(async () => true)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    setDenoiseMode(renderer, { whileConverging: true });
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    expect(samples).toBe(1);
    expect(pipeline.performOIDNDenoise).not.toHaveBeenCalled();

    renderer.oidn = {} as never;
    renderer.render(scene, camera);
    expect(samples).toBe(1);
    expect(pipeline.draw).toHaveBeenCalledOnce();
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pipeline.drawPostProcess).toHaveBeenCalledOnce();
    renderer.render(scene, camera);
    expect(pipeline.draw).toHaveBeenLastCalledWith(camera, 8);
  });

  it.each(['cancel', 'error'])('retries the first sample after an OIDN %s', async (failure) => {
    let samples = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const performOIDNDenoise = vi.fn(async () => true);
    if (failure === 'cancel') performOIDNDenoise.mockResolvedValueOnce(false);
    else performOIDNDenoise.mockRejectedValueOnce(new Error('OIDN failed'));
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => false),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = target;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderer.render(scene, camera);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(pipeline.drawPostProcess).not.toHaveBeenCalled();
      renderer.render(scene, camera);
      expect(samples).toBe(1);
      expect(pipeline.draw).toHaveBeenCalledOnce();
      expect(performOIDNDenoise).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(pipeline.drawPostProcess).toHaveBeenCalledOnce();
      renderer.render(scene, camera);
      expect(pipeline.draw).toHaveBeenLastCalledWith(camera, 8);
    } finally {
      logError.mockRestore();
    }
  });

  it(
    'keeps the while-converging settled 1spp target through compilation, tiles and OIDN',
    async () => {
      let samples = 1;
      let previewMode = true;
      let compiling = true;
      let tilesRemaining = 2;
      let finishDenoise!: (completed: boolean) => void;
      const renderer = new Renderer({
        canvas: { width: 1, height: 1 } as HTMLCanvasElement
      });
      renderer.maxSamples = 30;
      setDenoiseMode(renderer, { whileConverging: true });
      const pipeline = createPipeline({
        needsRestartSample: vi.fn(() => {
          if (!previewMode) return false;
          previewMode = false;
          return true;
        }),
        isPreviewMode: vi.fn(() => previewMode),
        draw: vi.fn((_camera: Camera, target: number) => {
          if (compiling) samples = 0;
          else if (--tilesRemaining === 0) samples = target;
          return compiling;
        }),
        getTotalSamplesRendered: vi.fn(() => samples),
        performOIDNDenoise: vi.fn(() => new Promise<boolean>((resolve) => {
          finishDenoise = resolve;
        }))
      });
      attachPipeline(renderer, pipeline);
      markSceneStable(renderer, scene);
      renderer.oidn = {} as never;
      (renderer as unknown as { _renderDone: boolean })._renderDone = true;
      (renderer as unknown as { _oidnStatus: number })._oidnStatus = 2;

      renderer.render(scene, camera);
      compiling = false;
      renderer.render(scene, camera);
      renderer.render(scene, camera);
      for (let call = 1; call <= 3; call++) {
        expect(pipeline.draw).toHaveBeenNthCalledWith(call, camera, 1);
      }
      expect(samples).toBe(1);
      expect(pipeline.performOIDNDenoise).toHaveBeenCalledOnce();
      expect(pipeline.setPreviewTransitionDenoisePending).toHaveBeenCalledWith(true);

      renderer.render(scene, camera);
      expect(pipeline.draw).toHaveBeenCalledTimes(3);
      expect(pipeline.drawPostProcess).not.toHaveBeenCalled();
      finishDenoise(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(pipeline.drawPostProcess).toHaveBeenCalledOnce();
      renderer.render(scene, camera);
      expect(pipeline.draw).toHaveBeenLastCalledWith(camera, 8);
    }
  );

  it('uses a one-sample target while the while-converging OIDN model is loading', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      getTotalSamplesRendered: vi.fn(() => 0)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    setDenoiseMode(renderer, { whileConverging: true });

    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenCalledWith(camera, 1);
  });

  it('selects the low-latency tile policy for while-converging denoising', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => false)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    const prepareForImage = vi.fn().mockResolvedValue(undefined);
    const denoiser = { prepareForImage } as never;
    renderer.oidn = denoiser;
    setDenoiseMode(renderer, { whileConverging: true });

    renderer.render(scene, camera);

    expect(pipeline.performOIDNDenoise).toHaveBeenCalledWith(
      denoiser,
      undefined,
      true
    );
    expect(prepareForImage).toHaveBeenLastCalledWith(1, 1, {
      tileOverlap: 80
    });
  });

  it('uses while-converging denoising during an active interactive preview', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => false),
      isPreviewMode: vi.fn(() => true)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    const denoiser = {} as never;
    renderer.oidn = denoiser;
    setDenoiseMode(renderer, { whileConverging: true });

    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenCalledWith(camera, 1);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledWith(
      denoiser,
      undefined,
      true
    );
  });

  it('does not denoise a one-sample interactive preview when while-converging OIDN is disabled', () => {
    let samples = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    renderer.maxSamples = 30;
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => true),
      isPreviewMode: vi.fn(() => true),
      draw: vi.fn(() => {
        samples = 1;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise: vi.fn(async () => true)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;

    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenCalledWith(camera, 30);
    expect(pipeline.performOIDNDenoise).not.toHaveBeenCalled();
  });

  it('denoises the first full-quality frame when preview settles', async () => {
    let samples = 0;
    let previewMode = false;
    let phase = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    renderer.maxSamples = 20;
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => {
        if (phase === 0) {
          previewMode = true;
          phase = 1;
          return true;
        }
        if (phase === 1) return false;
        previewMode = false;
        phase = 3;
        return true;
      }),
      isPreviewMode: vi.fn(() => previewMode),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = target;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise: vi.fn(async () => true)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });

    renderer.render(scene, camera);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    renderer.render(scene, camera);
    phase = 2;
    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenNthCalledWith(1, camera, 1);
    expect(pipeline.draw).toHaveBeenNthCalledWith(2, camera, 1);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledTimes(2);
    expect(pipeline.setPreviewTransitionDenoisePending).toHaveBeenCalledWith(
      true
    );
    expect(pipeline.drawPostProcess).toHaveBeenCalled();
  });

  it('waits for the final sample target when while-converging OIDN is disabled', async () => {
    let samples = 1;
    let previewMode = true;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    renderer.maxSamples = 30;
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => {
        previewMode = false;
        samples = 0;
        return true;
      }),
      isPreviewMode: vi.fn(() => previewMode),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = target;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise: vi.fn(async () => true)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    (renderer as unknown as { _renderDone: boolean })._renderDone = true;
    (renderer as unknown as { _oidnStatus: number })._oidnStatus = 2;

    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenCalledWith(camera, 30);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledOnce();
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledWith(
      renderer.oidn, undefined, false
    );
    expect(pipeline.setPreviewTransitionDenoisePending).toHaveBeenCalledWith(
      false
    );
  });

  it('continues static while-converging accumulation and denoises every eight samples', async () => {
    let samples = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => samples === 0),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = target;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise: vi.fn(async () => true)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });

    renderer.render(scene, camera);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    renderer.render(scene, camera);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenNthCalledWith(1, camera, 1);
    expect(pipeline.draw).toHaveBeenNthCalledWith(2, camera, 8);
    expect(pipeline.draw).toHaveBeenNthCalledWith(3, camera, 16);
    expect(pipeline.setPreserveOIDNOutput).toHaveBeenNthCalledWith(1, false);
    expect(pipeline.setPreserveOIDNOutput).toHaveBeenNthCalledWith(2, true);
    expect(pipeline.setPreserveOIDNOutput).toHaveBeenNthCalledWith(3, true);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledTimes(3);
  });

  it('waits for each asynchronous batch denoise before continuing accumulation', async () => {
    let samples = 0;
    let finishDenoise!: (completed: boolean) => void;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    renderer.maxSamples = 18;
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => false),
      draw: vi.fn(() => {
        samples++;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise: vi.fn(() => new Promise<boolean>((resolve) => {
        finishDenoise = resolve;
      }))
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });

    for (const [batch, target] of [1, 8, 16, 18].entries()) {
      while (samples < target) renderer.render(scene, camera);
      expect(pipeline.performOIDNDenoise).toHaveBeenCalledTimes(batch + 1);
      const draws = vi.mocked(pipeline.draw).mock.calls.length;
      // OIDN can take several animation frames, especially with tiled images.
      for (let frame = 0; frame < 3; frame++) renderer.render(scene, camera);
      expect(samples).toBe(target);
      expect(pipeline.draw).toHaveBeenCalledTimes(draws);
      expect(pipeline.performOIDNDenoise).toHaveBeenCalledTimes(batch + 1);
      finishDenoise(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(pipeline.drawPostProcess).toHaveBeenCalledTimes(batch + 1);
    }
    renderer.render(scene, camera);
    expect(samples).toBe(18);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledTimes(4);
  });

  it('accepts a custom while-converging OIDN interval that divides maxSamples', async () => {
    let samples = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    renderer.maxSamples = 32;
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => false),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = target;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise: vi.fn(async () => true)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true, sampleInterval: 4 });

    renderer.render(scene, camera);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenNthCalledWith(1, camera, 1);
    expect(pipeline.draw).toHaveBeenNthCalledWith(2, camera, 4);
  });

  describe('adaptive interval', () => {
    function setup(denoiseMs: number) {
      let now = 0;
      let samples = 0;
      let finishDenoise!: (completed: boolean) => void;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const renderer = new Renderer({
        canvas: { width: 1, height: 1 } as HTMLCanvasElement
      });
      renderer.maxSamples = 1000;
      const pipeline = createPipeline({
        needsRestartSample: vi.fn(() => false),
        // One sample per frame, 10 ms each.
        draw: vi.fn((_camera: Camera, target: number) => {
          if (samples < target) {
            samples++;
            now += 10;
          }
          return false;
        }),
        getTotalSamplesRendered: vi.fn(() => samples),
        performOIDNDenoise: vi.fn(() => new Promise<boolean>((resolve) => {
          finishDenoise = resolve;
        }))
      });
      attachPipeline(renderer, pipeline);
      markSceneStable(renderer, scene);
      renderer.oidn = {} as never;
      setDenoiseMode(renderer, { whileConverging: true, sampleInterval: undefined });
      /** Renders until OIDN starts, then completes it after `denoiseMs`. */
      async function nextUpdate() {
        const calls = pipeline.performOIDNDenoise.mock.calls.length;
        while (pipeline.performOIDNDenoise.mock.calls.length === calls) {
          renderer.render(scene, camera);
        }
        const denoisedAt = samples;
        now += denoiseMs;
        finishDenoise(true);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return denoisedAt;
      }
      return { nextUpdate, renderer, pipeline };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('doubles the sample count from the fourth sample', async () => {
      const { nextUpdate } = setup(0);
      const updates = [];
      for (let i = 0; i < 7; i++) updates.push(await nextUpdate());
      expect(updates).toEqual([1, 4, 8, 16, 32, 64, 128]);
    });

    it('does not skip updates when denoising is slow', async () => {
      const { nextUpdate } = setup(2000);
      const updates = [];
      for (let i = 0; i < 5; i++) updates.push(await nextUpdate());
      expect(updates).toEqual([1, 4, 8, 16, 32]);
    });

    it('updates at least every ten seconds', async () => {
      const { nextUpdate, renderer } = setup(0);
      renderer.maxSamples = 10000;
      const updates = [];
      for (let i = 0; i < 12; i++) updates.push(await nextUpdate());
      // At 10 ms per sample, 512 -> 1024 would take more than ten seconds.
      expect(updates.slice(-4)).toEqual([512, 1024, 2025, 3026]);
    });

    it('denoises the final sample count', async () => {
      const { nextUpdate, renderer } = setup(0);
      renderer.maxSamples = 20;
      const updates = [];
      for (let i = 0; i < 5; i++) updates.push(await nextUpdate());
      expect(updates).toEqual([1, 4, 8, 16, 20]);
    });
  });

  it('allows a while-converging OIDN interval that does not divide maxSamples', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    setDenoiseMode(renderer, { sampleInterval: 8 });
    renderer.maxSamples = 30;

    expect(() => {
      setDenoiseMode(renderer, { whileConverging: true });
    }).not.toThrow();
  });

  it('denoises the first frame after a camera move settles', async () => {
    let samples = 0;
    let cameraChanged = true;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => {
        const changed = cameraChanged;
        cameraChanged = false;
        return changed;
      }),
      draw: vi.fn((_camera: Camera, target: number) => {
        samples = target;
        return false;
      }),
      getTotalSamplesRendered: vi.fn(() => samples),
      performOIDNDenoise: vi.fn(async () => true)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });

    renderer.render(scene, camera);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    cameraChanged = true;
    renderer.render(scene, camera);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenNthCalledWith(1, camera, 1);
    expect(pipeline.draw).toHaveBeenNthCalledWith(2, camera, 1);
    expect(pipeline.draw).toHaveBeenCalledTimes(2);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledTimes(3);
  });

  it('restarts denoising when preview ends after a completed interactive denoise', () => {
    let previewMode = true;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      needsRestartSample: vi.fn(() => {
        previewMode = false;
        return true;
      }),
      isPreviewMode: vi.fn(() => previewMode),
      getTotalSamplesRendered: vi.fn(() => 1),
      performOIDNDenoise: vi.fn(async () => true)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });
    (renderer as unknown as { _renderDone: boolean })._renderDone = true;
    (renderer as unknown as { _oidnStatus: number })._oidnStatus = 2;

    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenCalledWith(camera, 1);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledTimes(1);
  });

  it('coalesces camera changes while a while-converging preview denoise is in flight', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline();
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });
    (renderer as unknown as { _renderDone: boolean })._renderDone = true;
    (renderer as unknown as { _oidnStatus: number })._oidnStatus = 1;
    (renderer as any)._oidnPreviewInFlight = true;
    (renderer as any)._forceMeshUpdate = false;

    renderer.render(scene, camera);

    expect(pipeline.needsRestartSample).not.toHaveBeenCalled();
    expect(pipeline.draw).not.toHaveBeenCalled();
  });

  it('lets a camera change cancel a settled while-converging denoise', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({ needsRestartSample: vi.fn(() => true) });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });
    (renderer as unknown as { _renderDone: boolean })._renderDone = true;
    (renderer as unknown as { _oidnStatus: number })._oidnStatus = 1;
    (renderer as any)._oidnPreviewInFlight = false;
    (renderer as any)._forceMeshUpdate = false;

    renderer.render(scene, camera);

    expect(pipeline.needsRestartSample).toHaveBeenCalled();
    expect(pipeline.draw).toHaveBeenCalled();
  });

  it('does not defer scene invalidation behind while-converging denoising', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({ setMeshes: vi.fn(() => true) });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });
    (renderer as unknown as { _renderDone: boolean })._renderDone = true;
    (renderer as unknown as { _oidnStatus: number })._oidnStatus = 1;

    renderer.render(scene, camera);

    expect(pipeline.needsRestartSample).toHaveBeenCalledWith(camera, true);
    expect(pipeline.draw).toHaveBeenCalledWith(camera, 1);
  });

  it('coalesces animated scene updates and denoises the latest state', () => {
    let sceneChanged = true;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      setMeshes: vi.fn(() => {
        const changed = sceneChanged;
        sceneChanged = false;
        return changed;
      }),
      needsRestartSample: vi.fn((_camera: Camera, changed?: boolean) => !!changed),
      getTotalSamplesRendered: vi.fn(() => 1)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    setDenoiseMode(renderer, { whileConverging: true });
    setDenoiseMode(renderer, { coalesceSceneUpdates: true });
    (renderer as unknown as { _renderDone: boolean })._renderDone = true;
    (renderer as unknown as { _oidnStatus: number })._oidnStatus = 1;

    renderer.render(scene, camera);

    expect(pipeline.needsRestartSample).not.toHaveBeenCalled();
    expect(pipeline.draw).not.toHaveBeenCalled();

    sceneChanged = true;
    scene.meshes = [...scene.meshes];
    renderer.render(scene, camera);
    expect(pipeline.needsRestartSample).not.toHaveBeenCalled();
    expect(pipeline.draw).not.toHaveBeenCalled();

    (renderer as unknown as { _oidnStatus: number })._oidnStatus = 2;
    renderer.render(scene, camera);

    expect(pipeline.needsRestartSample).toHaveBeenCalledWith(camera, true);
    expect(pipeline.draw).toHaveBeenCalledWith(camera, 1);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledOnce();
    expect(pipeline.setPreserveOIDNOutput).toHaveBeenLastCalledWith(true);
  });
});

describe('sampling pattern', () => {
  it('defaults to sobol and invalidates a finished render when its pattern changes', () => {
    const renderer = new Renderer({ canvas: {width:1,height:1} as HTMLCanvasElement });
    expect(renderer.samplingPattern).toBe('sobol');
    const pipeline = createPipeline({ needsRestartSample: vi.fn(() => false) });
    attachPipeline(renderer,pipeline);
    const scene = {meshes:[],lights:[]};
    const camera = {} as Camera;
    renderer.render(scene,camera);
    const draws = vi.mocked(pipeline.draw).mock.calls.length;
    renderer.render(scene,camera);
    expect(pipeline.draw).toHaveBeenCalledTimes(draws);
    renderer.samplingPattern = 'zsobol';
    vi.mocked(pipeline.setSamplingPattern).mockReturnValueOnce(true);
    renderer.render(scene,camera);
    expect(pipeline.setSamplingPattern).toHaveBeenLastCalledWith('zsobol',2048);
    expect(pipeline.draw).toHaveBeenCalledTimes(draws+1);
    renderer.oidn = {} as never;
    expect(renderer.samplingPattern).toBe('zsobol');
    renderer.oidn = undefined;
    expect(renderer.samplingPattern).toBe('zsobol');
    renderer.dispose();
  });
});

it('shares preparation between render and a concurrent explicit prepareScene call', async () => {
  vi.stubGlobal('Worker', class {});
  let finish!: (bvh: ReturnType<typeof buildBLAS>) => void;
  const build = vi.spyOn(bvhWorker, 'buildBvhInWorker').mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  try {
    const renderer = new Renderer({canvas: {width: 1, height: 1} as HTMLCanvasElement});
    const pipeline = createPipeline(); attachPipeline(renderer, pipeline);
    const scene: Scene = {meshes: [new Mesh(createCubeGeometry(), new OpenPBRMaterial())], lights: []};
    expect(renderer.render(scene, {} as Camera)).toBe('preparing');
    const explicit = renderer.prepareScene(scene);
    await Promise.resolve();
    expect(build).toHaveBeenCalledOnce();
    finish(buildBLAS(scene.meshes[0].geometry));
    await explicit;
    expect(build).toHaveBeenCalledOnce();
    expect(renderer.render(scene, {} as Camera)).not.toBe('preparing');
  } finally {build.mockRestore(); vi.unstubAllGlobals();}
});

it('keeps rendering the current scene during background preparation of another scene', async () => {
  vi.stubGlobal('Worker', class {});
  let finish!: (bvh: ReturnType<typeof buildBLAS>) => void;
  const build = vi.spyOn(bvhWorker, 'buildBvhInWorker').mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  try {
    const renderer = new Renderer({canvas: {width: 1, height: 1} as HTMLCanvasElement});
    const pipeline = createPipeline(); attachPipeline(renderer, pipeline);
    const current: Scene = {meshes: [new Mesh(createCubeGeometry(), new OpenPBRMaterial())], lights: []};
    updateMeshInstances(current.meshes); markSceneStable(renderer, current);
    const background = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
    const pending = renderer.prepareScene([background]); await Promise.resolve();
    expect(renderer.render(current, {} as Camera)).not.toBe('preparing');
    expect(pipeline.draw).toHaveBeenCalledOnce();
    finish(buildBLAS(background.geometry)); await pending;
  } finally {build.mockRestore(); vi.unstubAllGlobals();}
});

describe('render failures', () => {
  it('returns ERROR for draw and setting failures, records diagnostics and clears after recovery', () => {
    const renderer = new Renderer({canvas:{width:1,height:1} as HTMLCanvasElement});
    const pipeline = createPipeline(); attachPipeline(renderer,pipeline);
    const error = new Error('draw failed');
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      vi.mocked(pipeline.draw).mockImplementationOnce(()=>{throw error;});
      expect(renderer.render({meshes:[],lights:[]}, {} as Camera)).toBe('error');
      expect(renderer.lastError).toBe(error); expect(renderer.getDiagnostics()?.lastError).toBe('draw failed');
      renderer.render({meshes:[],lights:[]}, {} as Camera);
      expect(renderer.lastError).toBeUndefined(); expect(renderer.getDiagnostics()?.lastError).toBeUndefined();
      vi.mocked(pipeline.setOutput).mockImplementationOnce(()=>{throw 'setting failed';});
      expect(renderer.render({meshes:[],lights:[]}, {} as Camera)).toBe('error');
      expect(renderer.lastError?.message).toBe('setting failed');
    } finally {log.mockRestore();}
  });
  it('delivers constructor denoiser rejection through error events', async () => {
    const error = new Error('weights failed');
    const setter = vi.spyOn(Renderer.prototype,'setDenoiser').mockRejectedValueOnce(error);
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const renderer = new Renderer({canvas:{width:1,height:1} as HTMLCanvasElement,denoiser:{type:'jnlm'}});
      const listener = vi.fn(); renderer.on('error', listener);
      await new Promise(resolve=>setTimeout(resolve,0)); expect(renderer.lastError).toBeUndefined(); expect(listener).toHaveBeenCalledOnce(); expect(listener).toHaveBeenCalledWith(error);
    } finally {setter.mockRestore();log.mockRestore();}
  });
});


it('reports only final denoising and completion while converging', async () => {
  const renderer = new Renderer({canvas:{width:1,height:1} as HTMLCanvasElement});
  const denoised = vi.fn(); renderer.on('denoised', denoised);
  renderer.maxSamples = 8;
  let samples = 0;
  let complete: (value:boolean)=>void = ()=>{};
  const pipeline = createPipeline({
    needsRestartSample:vi.fn(()=>false),
    getTotalSamplesRendered:vi.fn(()=>samples),
    draw:vi.fn((_camera:Camera,target:number)=>{samples=target;return false;}),
    performOIDNDenoise:vi.fn(()=>new Promise<boolean>(resolve=>{complete=resolve;}))
  });
  attachPipeline(renderer,pipeline); const scene={meshes:[],lights:[]}; const camera={} as Camera;
  renderer.oidn = {} as never; setDenoiseMode(renderer,{whileConverging:true,sampleInterval:4});
  expect(renderer.render(scene,camera)).toBe('converging');
  expect(samples).toBe(1); expect(renderer.render(scene,camera)).toBe('converging');
  complete(true); await new Promise(resolve=>setTimeout(resolve,0));
  expect(renderer.render(scene,camera)).toBe('converging');
  expect(samples).toBe(4); expect(renderer.render(scene,camera)).toBe('converging');
  complete(true); await new Promise(resolve=>setTimeout(resolve,0));
  expect(renderer.render(scene,camera)).toBe('denoising');
  expect(samples).toBe(8); expect(renderer.render(scene,camera)).toBe('denoising');
  complete(true); await new Promise(resolve=>setTimeout(resolve,0));
  expect(renderer.render(scene,camera)).toBe('finished');
  expect(denoised.mock.calls.map(([event]) => event)).toEqual([{samples:1,final:false},{samples:4,final:false},{samples:8,final:true}]);
});


it('honors validateUpdates false and explicit true in production during render', () => {
  vi.stubEnv('NODE_ENV','production');
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    for(const enabled of [undefined,false,true]) {
      const renderer=new Renderer({canvas:{width:1,height:1} as HTMLCanvasElement,validateUpdates:enabled});
      attachPipeline(renderer,createPipeline());
      const material=new OpenPBRMaterial();const scene={meshes:[new Mesh(createCubeGeometry(),material)],lights:[]};
      renderer.render(scene,{} as Camera);material.baseColor[0]=.2;renderer.render(scene,{} as Camera);
      expect(warn.mock.calls.length).toBe(enabled===true?1:0);
    }
  } finally {vi.unstubAllEnvs();warn.mockRestore();}
});

it('exposes the initial and latest string render status', () => {
 const renderer = new Renderer({canvas: {width: 1, height: 1} as HTMLCanvasElement});
 expect(renderer.status).toBe('preparing');
 const pipeline = createPipeline();attachPipeline(renderer,pipeline);
 const status = renderer.render({meshes:[],lights:[]}, {} as Camera);
 expect(renderer.status).toBe(status);expect(status).toBe('finished');
});

it('supports multiple subscriptions, unsubscribe and status transitions', () => {
 const renderer=new Renderer({canvas:{width:1,height:1} as HTMLCanvasElement});
 const pipeline=createPipeline();attachPipeline(renderer,pipeline);
 const status=vi.fn(),first=vi.fn(),second=vi.fn();renderer.on('status',status);
 const off=renderer.on('sample',first);renderer.on('sample',second);
 renderer.render({meshes:[],lights:[]},{} as Camera);
 renderer.render({meshes:[],lights:[]},{} as Camera);
 expect(status).toHaveBeenCalledOnce(); expect(status).toHaveBeenCalledWith({status:'finished',previous:'preparing'});
 const sample=vi.mocked(pipeline.setOnSampleRendered).mock.calls.at(-1)![0]!;
 sample(2,false,3);off();sample(3,false,4);
 expect(first).toHaveBeenCalledOnce();expect(second).toHaveBeenCalledTimes(2);
 expect(second).toHaveBeenLastCalledWith({samples:3,preview:false,isFirstFrame:false,frameTimeMs:4});
});

it('delivers an async denoise rejection once and preserves it across later renders', async () => {
 const renderer=new Renderer({canvas:{width:1,height:1} as HTMLCanvasElement});renderer.maxSamples=1;
 const error=new Error('denoise rejected'),listener=vi.fn();renderer.on('error',listener);
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 const pipeline=createPipeline({needsRestartSample:vi.fn(()=>false),performOIDNDenoise:vi.fn().mockRejectedValueOnce(error).mockResolvedValue(true)});
 attachPipeline(renderer,pipeline);renderer.oidn={} as never;
 const scene={meshes:[],lights:[]},camera={} as Camera;
 renderer.render(scene,camera);await new Promise(resolve=>setTimeout(resolve,0));
 expect(listener).toHaveBeenCalledOnce(); expect(listener).toHaveBeenCalledWith(error);expect(renderer.lastError).toBeUndefined();
 renderer.render(scene,camera);await new Promise(resolve=>setTimeout(resolve,0));renderer.render(scene,camera);
 expect(listener).toHaveBeenCalledOnce(); expect(listener).toHaveBeenCalledWith(error);expect(listener.mock.calls[0][0]).toBe(error);expect(renderer.lastError).toBeUndefined();expect(log).toHaveBeenCalledOnce();log.mockRestore();
});

it('emits synchronous errors once per object while deduplicating console messages', () => {
 const renderer=new Renderer({canvas:{width:1,height:1} as HTMLCanvasElement});const error=new Error('same message');
 const pipeline=createPipeline({draw:vi.fn(()=>{throw error;})});attachPipeline(renderer,pipeline);
 const listener=vi.fn(),log=vi.spyOn(console,'error').mockImplementation(()=>{});renderer.on('error',listener);
 const scene={meshes:[],lights:[]},camera={} as Camera;
 renderer.render(scene,camera);renderer.render(scene,camera);
 expect(listener).toHaveBeenCalledOnce(); expect(listener).toHaveBeenCalledWith(error);expect(renderer.lastError).toBe(error);
 vi.mocked(pipeline.draw).mockImplementationOnce(()=>{throw new Error('same message');});renderer.render(scene,camera);
 expect(listener).toHaveBeenCalledTimes(2);expect(log).toHaveBeenCalledOnce();log.mockRestore();
});

it('clamps invalid lights and reports a validation event without a synchronous render error', async () => {
 const {default: SpotLight}=await import('../../src/scene/SpotLight');
 const renderer=new Renderer({canvas:{width:1,height:1} as HTMLCanvasElement});attachPipeline(renderer,createPipeline());
 const listener=vi.fn();renderer.on('error',listener);const light=new SpotLight({intensity:-1});
 const log=vi.spyOn(console,'error').mockImplementation(()=>{}),warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const scene={meshes:[],lights:[light]};renderer.render(scene,{} as Camera);renderer.render(scene,{} as Camera);
 expect(light.intensity).toBe(0);expect(listener).toHaveBeenCalledOnce();expect(renderer.lastError).toBeUndefined();expect(renderer.status).not.toBe('error');
 log.mockRestore();warn.mockRestore();
});
