import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { describe, expect, it, vi } from 'vitest';
import Renderer, { RENDER_STATUS_PREPARING } from '../../src/Renderer';
import { DEFAULT_MAX_TEXTURE_ARRAY_BYTES } from '../../src/renderer/MergedMaterialData';
import type { RenderingPipeline } from '../../src/renderer/RenderingPipeline';
import type { WGPURenderingPipeline } from '../../src/renderer/WGPURenderingPipeline';
import type Camera from '../../src/scene/Camera';
import Mesh from '../../src/scene/Mesh';
import { createCubeGeometry } from '../../src/main';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import type { Scene } from '../../src/scene/Scene';

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
    setStratifiedSampling: vi.fn(() => false),
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
    setOverlay: vi.fn(() => false),
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
    mesh.matrixWorld[12] = 2;
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
    const prepare = vi.spyOn(renderer, 'prepareScene').mockResolvedValue(undefined);
    const needsPreparation = vi.spyOn(renderer as any, '_needsBVHPreparation').mockReturnValue(true);
    expect(renderer.render(scene, {} as Camera)).toBe(RENDER_STATUS_PREPARING);
    expect(pipeline.setMeshes).not.toHaveBeenCalled();
    await Promise.resolve();
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
    vi.spyOn(renderer, 'getGPUDeviceAndAdapter').mockResolvedValue({
      device: undefined,
      adapter: undefined,
      adapterInfo: undefined
    });

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
    vi.spyOn(renderer, 'getGPUDeviceAndAdapter').mockResolvedValue({
      device: {
        queue: { onSubmittedWorkDone: vi.fn(async () => undefined) }
      } as unknown as GPUDevice,
      adapter: undefined,
      adapterInfo: undefined
    });

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
    vi.spyOn(renderer, 'getGPUDeviceAndAdapter').mockResolvedValue({
      device: {
        queue: {
          onSubmittedWorkDone: vi.fn(async () => {
            clock += queueDurations.shift() ?? 0;
          })
        }
      } as unknown as GPUDevice,
      adapter: undefined,
      adapterInfo: undefined
    });

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
    vi.spyOn(renderer, 'getGPUDeviceAndAdapter').mockResolvedValue({
      device: {
        queue: { onSubmittedWorkDone: vi.fn(async () => undefined) }
      } as unknown as GPUDevice,
      adapter: undefined,
      adapterInfo: undefined
    });

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

describe('Renderer realtime OIDN', () => {
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
      renderer.oidnRealtime = true;
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
    renderer.oidnRealtime = true;
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
    renderer.oidnRealtime = true;

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
    renderer.oidnRealtime = true;

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

  it('denoises the held 1spp frame as soon as the realtime model loads', async () => {
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
    renderer.oidnRealtime = true;
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
    renderer.oidnRealtime = true;
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
    'keeps the realtime settled 1spp target through compilation, tiles and OIDN',
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
      renderer.oidnRealtime = true;
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

  it('uses a one-sample target while the realtime OIDN model is loading', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({
      getTotalSamplesRendered: vi.fn(() => 0)
    });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidnRealtime = true;

    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenCalledWith(camera, 1);
  });

  it('selects the low-latency tile policy for realtime denoising', () => {
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
    renderer.oidnRealtime = true;

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

  it('uses realtime denoising during an active interactive preview', () => {
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
    renderer.oidnRealtime = true;

    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenCalledWith(camera, 1);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledWith(
      denoiser,
      undefined,
      true
    );
  });

  it('does not denoise a one-sample interactive preview when realtime OIDN is disabled', () => {
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
    renderer.oidnRealtime = true;

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

  it('waits for the final sample target when realtime OIDN is disabled', async () => {
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

  it('continues static realtime accumulation and denoises every eight samples', async () => {
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
    renderer.oidnRealtime = true;

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

  it('accepts a custom realtime OIDN interval that divides maxSamples', async () => {
    let samples = 0;
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement,
      oidnRealtimeSampleInterval: 4
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
    renderer.oidnRealtime = true;

    renderer.render(scene, camera);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenNthCalledWith(1, camera, 1);
    expect(pipeline.draw).toHaveBeenNthCalledWith(2, camera, 4);
  });

  it('allows a realtime OIDN interval that does not divide maxSamples', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement,
      oidnRealtimeSampleInterval: 8
    });
    renderer.maxSamples = 30;

    expect(() => {
      renderer.oidnRealtime = true;
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
    renderer.oidnRealtime = true;

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
    renderer.oidnRealtime = true;
    (renderer as unknown as { _renderDone: boolean })._renderDone = true;
    (renderer as unknown as { _oidnStatus: number })._oidnStatus = 2;

    renderer.render(scene, camera);

    expect(pipeline.draw).toHaveBeenCalledWith(camera, 1);
    expect(pipeline.performOIDNDenoise).toHaveBeenCalledTimes(1);
  });

  it('coalesces camera changes while a realtime denoise is in flight', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline();
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    renderer.oidnRealtime = true;
    (renderer as unknown as { _renderDone: boolean })._renderDone = true;
    (renderer as unknown as { _oidnStatus: number })._oidnStatus = 1;
    (renderer as any)._forceMeshUpdate = false;

    renderer.render(scene, camera);

    expect(pipeline.needsRestartSample).not.toHaveBeenCalled();
    expect(pipeline.draw).not.toHaveBeenCalled();
  });

  it('does not defer scene invalidation behind realtime denoising', () => {
    const renderer = new Renderer({
      canvas: { width: 1, height: 1 } as HTMLCanvasElement
    });
    const pipeline = createPipeline({ setMeshes: vi.fn(() => true) });
    attachPipeline(renderer, pipeline);
    markSceneStable(renderer, scene);
    renderer.oidn = {} as never;
    renderer.oidnRealtime = true;
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
    renderer.oidnRealtime = true;
    renderer.oidnRealtimeSceneUpdates = true;
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
