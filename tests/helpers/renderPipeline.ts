import { vi } from 'vitest';
import Engine from '../../src/Engine';
import Camera from '../../src/scene/Camera';
import type { Scene } from '../../src/scene/Scene';
import type { RenderPipeline, RenderTarget, TraceSettings } from '../../src/renderer/renderPipeline';

export function renderFixture(options: {tiles?: number; fits?: boolean; backend?: 'webgpu' | 'webgl'; validateUpdates?: boolean} = {}) {
  const operations: {id: string; kind: string; camera?: Camera; cap?: number}[] = [];
  const targets: RenderTarget[] = [];
  let active = '';
  const pipeline: RenderPipeline = {
    getSharedMemoryBytes: () => 0,
    setMeshes: vi.fn(() => true), setLights: vi.fn(), setBackground: vi.fn(), setTextureAtlasBudget: vi.fn(() => false),
    readDepthSamples: vi.fn(async () => new Float32Array([1])), getDiagnostics: vi.fn(() => ({targets: targets.map(t => ({label: t.label, ...t.getMemory()}))})), dispose: vi.fn(),
    createTarget(label) {
      let samples = 0, first = true, partial = 0, complete = false, width = 1, height = 1;
      let sequenceOffset = 0, variance = false, samplesPerBatch = 0;
      let callback = (_count: number, _first: boolean, _time: number) => {};
      const target = {
        label, invalidateDenoisedOutput: vi.fn(), configure: vi.fn((_settings: TraceSettings) => {}), synchronizeBackground: vi.fn(),
        activate: vi.fn(() => { active = label; operations.push({id: label, kind: 'activate'}); }),
        isFirstFrame: () => first, getTotalSamplesRendered: () => samples,
        get presentationComplete() { return complete; }, get presentationDenoised() { return false; },
        canCompleteSampleWithin: vi.fn(() => options.fits ?? true),
        trace: vi.fn((camera: Camera, cap: number) => {
          if (active !== label) throw new Error('Wrong active target');
          operations.push({id: label, kind: 'draw', camera: camera.clone(), cap});
          first = false;
          if (samples < cap && ++partial >= (options.tiles ?? 1)) {
            partial = 0; samples = Math.min(cap, samples + (samplesPerBatch || 1)); complete = true; callback(samples, samples === 1, 20);
          }
          return false;
        }),
        present: vi.fn(() => { if (active !== label) throw new Error('Wrong present target'); operations.push({id: label, kind: 'present'}); }),
        readPresentation: vi.fn(async () => ({width, height, data: new Float32Array(width * height * 4).fill(.5)})),
        restartSamples: vi.fn(() => { samples = 0; first = true; partial = 0; }),
        setSize: vi.fn((w: number, h: number) => {width = w; height = h;}),
        getMemory: () => ({width, height, bytes: width * height * 16}),
        setOnSampleRendered: vi.fn((fn: typeof callback) => {callback = fn;}),
        setOfflineRenderOptions: vi.fn((value: {sampleSequenceOffset: number; samplesPerBatch: number}) => {sequenceOffset = value.sampleSequenceOffset; samplesPerBatch = value.samplesPerBatch;}),
        readOutput: vi.fn(async () => {
          if (active !== label) throw new Error('Wrong read target');
          operations.push({id: label, kind: 'read'});
          return {width, height, data: new Float32Array([Number(label.split('-')[1]), samples, sequenceOffset, +variance])};
        }),
        prepareOfflineAdaptiveSampling: vi.fn(async () => undefined),
        setVarianceMoments: vi.fn((value: boolean) => {variance = value;}), setAdaptiveSamplingTargets: vi.fn(),
        cancelOIDNDenoise: vi.fn(), performOIDNDenoise: vi.fn(async () => true), setPreserveOIDNOutput: vi.fn(),
        setToneMappingParams: vi.fn(() => false), setBloomParams: vi.fn(() => false), setHDROutputEnabled: vi.fn(() => false),
        setOutput: vi.fn(() => false), setShadowCatcherParams: vi.fn(() => false),
        drawPostProcess: vi.fn(), dispose: vi.fn(),
      } as unknown as RenderTarget;
      targets.push(target); return target;
    },
    releaseTarget: vi.fn(target => {target.dispose();}),
  };
  const canvas = {width: 800, height: 600} as HTMLCanvasElement;
  const engine = new Engine({canvas, validateUpdates: 'validateUpdates' in options ? options.validateUpdates : false});
  const state = engine as unknown as {_pipeline: RenderPipeline; _info: {backend: 'webgpu' | 'webgl'}; _gpuDevice?: GPUDevice};
  state._pipeline = pipeline; state._info = {backend: options.backend ?? 'webgpu'};
  if (state._info.backend === 'webgpu') state._gpuDevice = {queue: {onSubmittedWorkDone: async () => {}}} as GPUDevice;
  vi.spyOn(engine, 'init').mockResolvedValue({backend: state._info.backend, adapterName: 'fake', limits: {maxTextureArrayLayers: 1, maxTextureDimension2D: 8192}});
  const scene: Scene = {meshes: [], lights: []};
  const camera = new Camera({projection: 'perspective'});
  engine.scene = scene; engine.camera = camera; engine.update();
  return {engine, camera, scene, canvas, pipeline, targets, operations};
}
