import { textureBytes } from './gpuMemory.js';
import { makeProgressivePipeline, type AccumulationTargetOptions, type TargetPipeline, type ResidentRenderingPipeline } from './accumulationTarget.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import type { SamplingPattern } from './sampling.js';
import Mesh from '../scene/Mesh.js';
import { SceneBackground, SceneLight } from '../scene/Scene.js';
import Camera from '../scene/Camera.js';

import { WGPUFullQuadPass } from './WGPUFullQuadPass.js';
import WGPURayTracePass from './WGPURayTracePass.js';
import {
  composeMain,
  composeDefine,
  compositeDenoiseOutputMain,
  compositeDenoiseDisplayMain,
  linearToSrgbDefine
} from './wgsl/compose.frag.wgsl.js';
import halton from './halton.js';
import { MIN_PREVIEW_SCALE, nextPreviewScale } from './util.js';
import type { RenderingPipeline } from './RenderingPipeline.js';
import { makeTileRender, makeTileRenderWithPredict } from './TileRender.js';
import { ToneMappingParams } from './RenderingPipeline.js';
import type { AlphaBlendStrategy } from './RenderingPipeline.js';
import { RenderOutput } from './RenderingPipeline.js';
import { ColorRGB } from '../types.js';
import { WGPURayTraceOutputPass } from './WGPURayTraceOutput.js';
import { vec3 } from '../math.js';

import WGPUBloomPass from './WGPUBloomPass.js';
import { WGPUComputePass } from './WGPUComputePass.js';
import WGPUHDRPeakMeter from './WGPUHDRPeakMeter.js';
import { isJNLMDenoiser, type JNLMDenoiser } from './jnlm.js';
import { WGPUJNLMDenoisePass } from './WGPUJNLMDenoiser.js';

export interface OIDNWebGPUData {
  data: GPUBuffer | GPUTexture;
  width: number;
  height: number;
}
interface OIDNWebGPUOutputData {
  data: GPUBuffer;
  width: number;
  height: number;
}

export interface OIDNWeb {
  auxiliaryDenoisers?: {
    albedo: OIDNWeb;
    normal: OIDNWeb;
  };
  /** Optional serializable execution details exposed by native oidn-web. */
  getRuntimeInfo?: () => unknown;
  /** Optional shape preparation supported by newer oidn-web runtimes. */
  prepareForImage?: (
    width: number,
    height: number,
    options?: { tileOverlap?: number }
  ) => Promise<void>;
  tileExecute: (opts: {
    color: OIDNWebGPUData;
    albedo?: OIDNWebGPUData;
    normal?: OIDNWebGPUData;
    denoiseAlpha?: boolean;
    wholeImage?: boolean;
    tileOverlap?: number;
    scheduling?: 'animation-frame' | 'event-loop';
    done: (outputData: {
      data: GPUBuffer;
      width: number;
      height: number;
    }) => void;
    error?: (reason: unknown) => void;
    progress?: (
      outputData: OIDNWebGPUOutputData,
      tileData: OIDNWebGPUOutputData | undefined,
      tile: { x: number; y: number; width: number; height: number },
      currentIdx: number,
      totalIdx: number
    ) => void;
  }) => () => void;
}

export const oidnAlbedoSrgbEncodeMain = /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
let raw = textureLoad(in_albedo, vec2u(globalId.xy), 0);
let linear = clamp(raw.rgb, vec3f(0.0), vec3f(1.0));
let encoded = select(
  1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055,
  12.92 * linear,
  linear <= vec3f(0.0031308)
);
out_albedo[index] = vec4f(encoded, raw.a);
`;

export const oidnAlbedoSrgbDecodeMain = /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
let filtered = in_albedo[index];
let encoded = clamp(filtered.rgb, vec3f(0.0), vec3f(1.0));
let linear = select(
  pow((encoded + 0.055) / 1.055, vec3f(2.4)),
  encoded / 12.92,
  encoded <= vec3f(0.04045)
);
var result = linear;
let surfaceCoverage = textureLoad(in_rawAlbedo, vec2i(globalId.xy), 0).a;
if (preserveSurfaceTexture != 0u) {
  // Primary albedo retains the accumulated surface texture. Do not ask the
  // auxiliary network to reconstruct its high-frequency texture.
  // Retain its filtered result across normal/coverage discontinuities.
  let pixel = vec2i(globalId.xy);
  let center = textureLoad(in_rawNormal, pixel, 0);
  let n = normalize(center.rgb * 2.0 - 1.0 + vec3f(1e-8));
  var discontinuity = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let neighbor = textureLoad(in_rawNormal,
        clamp(pixel + vec2i(x, y), vec2i(0), imageSize - 1), 0);
      let nn = normalize(neighbor.rgb * 2.0 - 1.0 + vec3f(1e-8));
      discontinuity = max(discontinuity,
        max(1.0 - dot(n, nn), abs(center.a - neighbor.a)));
    }
  }
  let edgeWeight = smoothstep(0.02, 0.1, discontinuity);
  let raw = clamp(textureLoad(in_rawAlbedo, pixel, 0).rgb,
    vec3f(0.0), vec3f(1.0));
  result = mix(raw, linear, edgeWeight);
}
out_albedo[index] = vec4f(result, surfaceCoverage);
`;

export const oidnNormalSanitizeMain = /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
out_normal[index] = vec4f(clamp(in_normal[index].rgb, vec3f(0.0), vec3f(1.0)), 1.0);
`;
export interface WGPURenderingPipeline extends RenderingPipeline {
  setOIDNPreviewActive(active: boolean): void;
  setDirectLightCandidates(candidates: number): boolean;
  setAlphaBlendStrategy(strategy: AlphaBlendStrategy): boolean;
  cancelOIDNDenoise(): void;
  performOIDNDenoise(
    denoiser: OIDNWeb | JNLMDenoiser,
    denoiserAlpha: OIDNWeb | undefined,
    whileConverging?: boolean
  ): Promise<boolean>;
}

export interface WGPURenderingPipelineOptions {
  presentationFormat?: GPUTextureFormat;
}

type HDRCanvasConfiguration = GPUCanvasConfiguration & {
  toneMapping: { mode: 'extended' };
};

type InspectableGPUCanvasContext = GPUCanvasContext & {
  getConfiguration?: () => GPUCanvasConfiguration & {
    toneMapping?: { mode?: 'standard' | 'extended' };
  };
};


function createTimeQuery(device: GPUDevice) {
  try {
    const querySet = device.createQuerySet({
      type: 'timestamp',
      count: 2
    });
    const resolveBuffer = device.createBuffer({
      size: querySet.count * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    });
    const resultBuffer = device.createBuffer({
      size: resolveBuffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    return {
      querySet,
      resolveBuffer,
      resultBuffer
    };
  } catch (e) {
    console.error(e);
    return undefined;
  }
}

function makeWGPUAccumulationTarget(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  {
    presentationFormat = navigator.gpu.getPreferredCanvasFormat()
  }: WGPURenderingPipelineOptions,
  rayTracePass: WGPURayTracePass,
  targetOptions: AccumulationTargetOptions,
  onComplete: (complete?: boolean) => void,
  configureContext: boolean
) {
  const presentationAlphaMode: GPUCanvasAlphaMode = 'premultiplied';
  let sampleRenderedCallback: (
    sampleCount: number,
    isFirstFrame: boolean,
    frameTime: number
  ) => void = () => {};

  let allowMultipleSamplesPerFrame = false;
  let offlineSamplesPerBatch = 0;
  let deferPostProcess = false;
  let sampleSequenceOffset = 0;

  let sampleCount = 0;
  let elapsedFrameTime = 32;
  let elapsedTileTime: number | undefined;
  let tileTimingGeneration = 0;
  let lastGpuTraceTiming:
    | {
        tileTimeMs: number;
        tileTimePerSampleMs?: number;
        estimatedFullFrameTimeMs: number;
        tileCount: number;
      }
    | undefined;
  let diagnosticsReadbackPromise: Promise<void> = Promise.resolve();

  let isFirstFrame = true;
  let disposed = false;

  let needsUpdatePredicting = true;
  let isPredictingFrame = false;

  let renderWidth = 0;
  let renderHeight = 0;
  let screenWidth = 0;
  let screenHeight = 0;


  const previewMode = targetOptions.preview ?? false;
  const targetKey = {};
  let qualityBounces = 8;
  let qualityCandidates = 4;
  let resolvedSamples = 0;
  let presentationTexture: GPUTexture | undefined;
  let presentationDenoised = false;
  let denoiseValid = false;
  const retiredDenoiseTextures = new Set<GPUTexture>();
  let previewMaxResolutionScale = 0.5;
  let adaptivePreviewScale = 0.5;
  // While-converging OIDN runs on every preview frame and usually costs more than the
  // trace, which the timestamp feedback below does not see. Its measured time
  // sets a separate limit, allowed to go lower than tracing alone.
  const OIDN_PREVIEW_TARGET_MS = 40;
  const MIN_OIDN_PREVIEW_SCALE = 0.125;
  let oidnPreviewActive = false;
  // Whether the canvas currently shows a denoised (or transition) frame.

  let oidnPreviewScaleLimit: number | undefined;
  let previewBounces = 2;



  let maxTimePerTile = 21;
  let previewTargetFrameMs = 20;


  let bloomIntensity = 0;
  let bloomThreshold = 1;
  let bloomRadius = 0.6;

  let exposure = 1;
  let toneMappingMode = 0;
  let contrast = 1;
  let saturation = 1;
  let temperature = 0;
  let tint = 0;
  let vignette = 0;
  let hdrOutputRequested = false;
  let hdrOutputActive = false;
  let output: RenderOutput = 'final';
  let shadowCatcherColor = vec3.create();
  let shadowCatcherAlpha = 1;

  let pageLeaveTime = performance.now();
  let pageInvisibleTime = 0;

  let oidnComposedBuffer: GPUBuffer | undefined;
  let oidnComposedTexture: GPUTexture | undefined;
  let oidnComposedLinear = false;
  let oidnAlbedoGuideTexture: GPUTexture | undefined;
  let oidnNormalGuideTexture: GPUTexture | undefined;
  let jnlmPass: WGPUJNLMDenoisePass | undefined;
  let oidnGeneration = 0;
  let preserveOIDNOutput = false;

  let activeOidnPhase:
    | {
        abort: () => void;
        finish: () => void;
      }
    | undefined;

  function cancelOIDNDenoise() {
    oidnGeneration++;
    const activePhase = activeOidnPhase;
    activeOidnPhase = undefined;
    if (activePhase) {
      try {
        activePhase.abort();
      } finally {
        activePhase.finish();
      }
    }
  }

  function runOIDNPhase(
    generation: number,
    execute: (
      finish: () => void,
      fail: (reason: unknown) => void
    ) => () => void
  ): Promise<void> {
    if (generation !== oidnGeneration) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let settled = false;
      let phase:
        | {
            abort: () => void;
            finish: () => void;
          }
        | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (activeOidnPhase === phase) activeOidnPhase = undefined;
        resolve();
      };
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        if (activeOidnPhase === phase) activeOidnPhase = undefined;
        reject(reason);
      };

      try {
        const abort = execute(finish, fail);
        phase = { abort, finish };
        if (settled) return;
        if (generation !== oidnGeneration) {
          abort();
          finish();
          return;
        }
        activeOidnPhase = phase;
      } catch (error) {
        if (activeOidnPhase === phase) activeOidnPhase = undefined;
        settled = true;
        reject(error);
      }
    });
  }

  const standardPresentationFormat = presentationFormat;
  let currentPresentationFormat = standardPresentationFormat;
  const ctx = canvas.getContext('webgpu')! as InspectableGPUCanvasContext;
  if (configureContext) ctx.configure({
    device,
    format: standardPresentationFormat,
    alphaMode: presentationAlphaMode
  });

  const timeQuery = device.features.has('timestamp-query')
    ? createTimeQuery(device)
    : undefined;
  const tileRender = makeTileRender();
  const tileRenderWithPredict = timeQuery ? makeTileRenderWithPredict() : undefined;
  tileRender.setDesiredMsPerTile(previewMode ? previewTargetFrameMs : maxTimePerTile);
  tileRenderWithPredict?.setDesiredMsPerTile(previewMode ? previewTargetFrameMs : maxTimePerTile);

  function invalidateTilePrediction() {
    tileTimingGeneration++;
    tileRenderWithPredict?.needsUpdatePredicting();
    // Renderer applies settings after configuring an offline batch. Refresh
    // its estimator without submitting a hidden probe in that mode.
    needsUpdatePredicting = offlineSamplesPerBatch === 0;
    isPredictingFrame = false;
  }


  const rayTraceOutputPass = new WGPURayTraceOutputPass(device);
  const getFrameInput = (label: 'color' | 'albedo' | 'normal' | 'shadowCatcher' | 'foreground' | 'catcherBackground') =>
    rayTraceOutputPass.getOutput(label);
  let bloomPass: WGPUBloomPass | undefined;

  // Primary misses on a flat colour background are blank: they add the
  // background radiance but no surface hit, and the normalized colour divides
  // by hits only. Raw readback restores the per-sample average, as on WebGL.
  // Fully blank pixels are already divided by the sample count.
  const rawOutputPass = new WGPUFullQuadPass('raw output', device, {
    textureWillBeRead: true,
    inputs: ['colorTex', 'coverageTex'],
    outputs: ['color'],
    uniforms: [{ label: 'flatBackgroundColor', type: 'vec4f', data: [0, 0, 0, 0] }],
    fsMain: /* wgsl */ `
var color = textureLoad(colorTex, uv, 0);
let coverage = clamp(textureLoad(coverageTex, uv, 0).a, 0.0, 1.0);
if (flatBackgroundColor.a > 0.5 && coverage > 0.0) {
  color = vec4f(color.rgb * coverage, color.a);
}
output.color = color;
`
  });

  const readbackPass = new WGPUFullQuadPass('output readback', device, {
    textureWillBeRead: true, inputs: ['inputTex'], outputs: ['color'],
    fsMain: 'output.color = textureLoad(inputTex, uv, 0);'
  });
  readbackPass.setOutputParams({color: {format: 'rgba32float'}});

  let hdrPeakMeter: WGPUHDRPeakMeter | undefined;
  const composePass = new WGPUFullQuadPass('compose', device, {
    textureWillBeRead: true,
    fsMain: composeMain + compositeDenoiseOutputMain,
    fsDefine: composeDefine,
    uniforms: [
      {
        label: 'exposure',
        type: 'f32',
        data: exposure
      },
      {
        label: 'toneMappingParams',
        type: 'vec2f',
        data: [toneMappingMode, vignette]
      },
      {
        label: 'hdrOutputEnabled',
        type: 'f32',
        data: 0
      },
      {
        label: 'colorGradingParams',
        type: 'vec4f',
        data: [contrast, saturation, temperature, tint]
      },
      {
        label: 'flatBackgroundColor',
        type: 'vec4f',
        data: [0, 0, 0, 0]
      },
      {
        label: 'shadowCatcherColor',
        type: 'vec3f',
        data: shadowCatcherColor
      },
      {
        label: 'shadowCatcherAlpha',
        type: 'f32',
        data: shadowCatcherAlpha
      },
      {
        label: 'shadowCatcherEnabled',
        type: 'f32',
        data: 0
      },
      {
        label: 'bloomIntensity',
        type: 'f32',
        data: 0.25
      }
    ],
    outputs: ['color', 'denoiseColor'],
    inputs: [
      'colorTex',
      'foregroundTex',
      'catcherBackgroundTex',
      'flatBackgroundMaskTex',
      'shadowCatcherTex',
      'bloomTex'
    ]
  });
  let composeColorFormat: GPUTextureFormat = 'rgba8unorm';
  composePass.setOutputParams({
    color: {
      format: composeColorFormat
    },
    denoiseColor: { format: 'rgba32float' }
  });
  const compositeDenoiseDisplayPass = new WGPUFullQuadPass(
    'OIDN composed display', device, {
      textureWillBeRead: true,
      fsMain: compositeDenoiseDisplayMain,
      fsDefine: linearToSrgbDefine,
      uniforms: [
        { label: 'hdrOutputEnabled', type: 'f32', data: 0 },
        { label: 'denoisedAlpha', type: 'f32', data: 0 }
      ],
      outputs: ['color'], inputs: ['colorTex', 'composedTex']
    }
  );
  compositeDenoiseDisplayPass.setOutputParams({ color: { format: 'rgba8unorm' } });
  const auxiliaryPassUniforms = [
    {
      label: 'imageSize',
      type: 'vec2i' as const,
      data: new Int32Array([1, 1])
    }
  ];
  const oidnAlbedoEncodePass = new WGPUComputePass<'albedo', 'albedo'>(
    'OIDN albedo sRGB encode',
    device,
    {
      inputs: ['albedo'],
      outputs: ['albedo'],
      uniforms: auxiliaryPassUniforms,
      csMain: oidnAlbedoSrgbEncodeMain
    }
  );
  const oidnAlbedoDecodePass = new WGPUComputePass<'albedo' | 'rawAlbedo' | 'rawNormal', 'albedo'>(
    'OIDN albedo sRGB decode',
    device,
    {
      inputs: ['albedo', 'rawAlbedo', 'rawNormal'],
      outputs: ['albedo'],
      uniforms: [...auxiliaryPassUniforms, {
        label: 'preserveSurfaceTexture', type: 'u32', data: 0
      }],
      csMain: oidnAlbedoSrgbDecodeMain
    }
  );
  const oidnNormalSanitizePass = new WGPUComputePass<'normal', 'normal'>(
    'OIDN normal sanitize',
    device,
    {
      inputs: ['normal'],
      outputs: ['normal'],
      uniforms: auxiliaryPassUniforms,
      csMain: oidnNormalSanitizeMain
    }
  );
  oidnAlbedoEncodePass.setOutputParams({ albedo: { channels: 4 } });
  oidnAlbedoDecodePass.setOutputParams({ albedo: { channels: 4 } });
  oidnNormalSanitizePass.setOutputParams({ normal: { channels: 4 } });
  const outputPass = new WGPUFullQuadPass('output', device, {
    fsMain: /* wgsl */ `
let colorUv = min(
  vec2i(uv2 * vec2f(textureDimensions(colorTex))),
  vec2i(textureDimensions(colorTex)) - vec2i(1)
);
var color = textureLoad(colorTex, colorUv, 0);
color = vec4(color.rgb * color.a, color.a);
output.color = color;
`,
    outputs: ['color'],
    inputs: ['colorTex']
  });
  outputPass.setOutputParams({
    color: {
      format: 'rgba8unorm'
    }
  });

  function _present(encoder: GPUCommandEncoder, texture: GPUTexture) {
    outputPass.setRenderToScreen(
      ctx.getCurrentTexture(),
      currentPresentationFormat
    );
    outputPass.createPass(encoder, {
      colorTex: texture
    });
  }

  function _updateSeed(width: number, height: number) {
    const sequenceSample = sampleCount + sampleSequenceOffset;
    // Each ray includes a .5 pixel center, so its Halton jitter in [-.5,.5)
    // becomes a sub-pixel offset in [0,1).
    const jitterX = halton(sequenceSample, 2) - 0.5;
    const jitterY = halton(sequenceSample, 3) - 0.5;
    rayTracePass.setJitter(jitterX / width, jitterY / height);
  }

  function sample(clear: boolean, tiles: [number, number]) {
    const encoder = device.createCommandEncoder();
    rayTracePass.setSampleCount(sampleCount + sampleSequenceOffset);
    rayTracePass.setSampleSequenceOffset(sampleSequenceOffset);
    _updateSeed(renderWidth, renderHeight);
    const activeTimeQuery = timeQuery;
    const isUnmapped = activeTimeQuery?.resultBuffer.mapState === 'unmapped';
    rayTracePass.createPass(
      encoder,
      clear,
      tiles,
      activeTimeQuery ? { querySet: activeTimeQuery.querySet } : undefined
    );
    if (activeTimeQuery) {
      encoder.resolveQuerySet(
        activeTimeQuery.querySet,
        0,
        activeTimeQuery.querySet.count,
        activeTimeQuery.resolveBuffer,
        0
      );
      if (isUnmapped) {
        encoder.copyBufferToBuffer(
          activeTimeQuery.resolveBuffer,
          0,
          activeTimeQuery.resultBuffer,
          0,
          activeTimeQuery.resultBuffer.size
        );
      }
    }

    // TODO if encoder is not submitted. The uniform buffer will be replaced
    device.queue.submit([encoder.finish()]);

    const submittedTileRenderWithPredict = tileRenderWithPredict;
    const submittedTimingGeneration = tileTimingGeneration;
    if (activeTimeQuery && isUnmapped && submittedTileRenderWithPredict) {
      const submittedPreviewMode = previewMode;
      const submittedScale = adaptivePreviewScale;
      const submittedTileCount = tiles[0] * tiles[1];
      diagnosticsReadbackPromise = activeTimeQuery.resultBuffer
        .mapAsync(GPUMapMode.READ).then(() => {
        const mappedRange = activeTimeQuery.resultBuffer.getMappedRange();
        const times = new BigInt64Array(mappedRange, 0, 2);
        const traceTime = Math.max(Number(times[1] - times[0]) / 1_000_000, 0.1);
        // A readback may finish after scene preparation or a mode switch.
        // It must not overwrite throughput learned for the current scene.
        const timingIsCurrent =
          !disposed && submittedTimingGeneration === tileTimingGeneration &&
          !isFirstFrame;
        if (timingIsCurrent) {
          lastGpuTraceTiming = {
            tileTimeMs: traceTime,
            tileTimePerSampleMs: traceTime,
            estimatedFullFrameTimeMs: traceTime * submittedTileCount,
            tileCount: submittedTileCount
          };
          submittedTileRenderWithPredict.setLastTraceTime(traceTime);
        }
        activeTimeQuery.resultBuffer.unmap();

        if (timingIsCurrent && submittedPreviewMode && previewMode) {
          const nextScale = nextPreviewScale(
            submittedScale,
            traceTime * submittedTileCount,
            previewTargetFrameMs,
            maxPreviewScale(),
            adaptivePreviewScale,
            oidnPreviewActive ? MIN_OIDN_PREVIEW_SCALE : MIN_PREVIEW_SCALE
          );
          if (nextScale !== adaptivePreviewScale) {
            adaptivePreviewScale = nextScale;
            _applyRenderResolution();
            isFirstFrame = true;
          }
        }
      }).catch(() => {
        if (activeTimeQuery.resultBuffer.mapState === 'mapped') {
          activeTimeQuery.resultBuffer.unmap();
        }
      });
    }
  }

  function clearOIDNOutput() { denoiseValid = false; }

  function invalidateCompositeDenoise() {
    if (!oidnComposedLinear) return;
    cancelOIDNDenoise();
    denoiseValid = false;
  }

  function prepareOIDNTexture(
    encoder: GPUCommandEncoder,
    buffer: GPUBuffer | undefined,
    texture: GPUTexture | undefined
  ) {
    if (!buffer) {
      return undefined;
    }
    if (
      !texture ||
      texture.width !== renderWidth ||
      texture.height !== renderHeight
    ) {
      if (texture && texture !== presentationTexture) texture.destroy();
      else if (texture) retiredDenoiseTextures.add(texture);
      texture = device.createTexture({
        size: {
          width: renderWidth,
          height: renderHeight,
          depthOrArrayLayers: 1
        },
        format: 'rgba32float',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC
      });
    }
    encoder.copyBufferToTexture(
      { buffer: buffer!, bytesPerRow: 16 * renderWidth },
      {
        texture: texture
      },
      {
        width: renderWidth,
        height: renderHeight,
        depthOrArrayLayers: 1
      }
    );
    return texture;
  }

  function copyOIDNOutput(
    encoder: GPUCommandEncoder,
    output: OIDNWebGPUOutputData,
    target: GPUBuffer | undefined
  ) {
    if (!target || target.size !== output.data.size) {
      target?.destroy();
      target = device.createBuffer({
        label: 'OIDN persistent output',
        size: output.data.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      });
    }
    encoder.copyBufferToBuffer(output.data, 0, target, 0, output.data.size);
    return target;
  }

  function drawPostProcess(
    encoder: GPUCommandEncoder,
    _forceNeedsDenoise?: boolean,
    resolve = false
  ) {
    if (resolve) resolvedSamples = sampleCount;
    if (resolvedSamples < 1) return;
    if (denoiseValid) oidnComposedTexture = prepareOIDNTexture(
      encoder,
      oidnComposedBuffer,
      oidnComposedTexture
    );
    if (resolve) {
      rayTraceOutputPass.setSampleCount(sampleCount);
      rayTraceOutputPass.createPass(encoder, rayTracePass.getOutputBuffer(), rayTracePass.hasShadowCatcher());
    }

    composePass.setUniform(
      'shadowCatcherEnabled',
      +(rayTracePass.hasShadowCatcher())
    );

    const foregroundTexture = getFrameInput(
      rayTracePass.hasShadowCatcher() ? 'foreground' : 'color'
    );
    const colorTexture = getFrameInput('color');
    const bloomEnabled = bloomIntensity > 0.0;
    // Progressive accumulation refreshes bloom every ten samples.
    const samplesSkipped = sampleCount < 10 || sampleCount % 10 > 0;
    const needsUpdateBloom =
      bloomEnabled && !samplesSkipped;
    let bloomIntensityToUpdate = bloomIntensity;
    if (needsUpdateBloom) {
      if (!bloomPass) {
        bloomPass = new WGPUBloomPass(device);
        bloomPass.setSize(renderWidth, renderHeight);
      }
      bloomPass.setBrightThreshold(bloomThreshold);
      bloomPass.setRadius(bloomRadius);
      bloomPass.createPass(encoder, colorTexture);
    } else if (bloomEnabled && sampleCount < 10) {
      bloomIntensityToUpdate = 0;
    }
    composePass.setUniform('bloomIntensity', bloomIntensityToUpdate);
    composePass.createPass(encoder, {
      colorTex: colorTexture,
      foregroundTex: foregroundTexture,
      catcherBackgroundTex: getFrameInput('catcherBackground'),
      flatBackgroundMaskTex: getFrameInput('albedo'),
      shadowCatcherTex: getFrameInput('shadowCatcher'),
      // Use color texture as placeholder
      bloomTex: bloomEnabled && bloomPass ? bloomPass.getOutput() : colorTexture
    });
    if (denoiseValid && oidnComposedLinear && oidnComposedTexture) {
      compositeDenoiseDisplayPass.createPass(encoder, {
        colorTex: oidnComposedTexture,
        composedTex: composePass.getOutput('denoiseColor')
      });
    }
    let displayTexture =
      (denoiseValid && oidnComposedBuffer ? (oidnComposedLinear
        ? compositeDenoiseDisplayPass.getOutput('color') : oidnComposedTexture) : undefined) ||
      composePass.getOutput('color');
    const activeHDRPeakMeter = hdrOutputActive
      ? (hdrPeakMeter ??= new WGPUHDRPeakMeter(device))
      : undefined;
    const hdrPeakReadbackSubmitted =
      activeHDRPeakMeter?.encode(
        encoder,
        displayTexture,
        renderWidth,
        renderHeight
      ) ?? false;

    if (output === 'normal' || output === 'albedo') {
      displayTexture = getFrameInput(output);
    } else if (output === 'shadowCatcher') {
      displayTexture = getFrameInput('shadowCatcher');
    }

    // Keep the completed denoise visible until its replacement is ready.
    if (!(oidnPreviewActive && output === 'final' && !denoiseValid && presentationDenoised)) {
      if (presentationTexture !== displayTexture) {
        const owners = [composePass, compositeDenoiseDisplayPass, rayTraceOutputPass];
        for (const pass of owners) {
          pass.retainOutput(displayTexture);
          if (presentationTexture) pass.releaseOutput(presentationTexture);
        }
      }
      for (const texture of retiredDenoiseTextures) {
        if (texture !== displayTexture) {
          void device.queue.onSubmittedWorkDone().catch(() => undefined).then(() => texture.destroy());
          retiredDenoiseTextures.delete(texture);
        }
      }
      presentationTexture = displayTexture;
      presentationDenoised = output === 'final' && denoiseValid;
    }
    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);
    if (hdrPeakReadbackSubmitted) {
      void activeHDRPeakMeter?.resolve();
    }
  }

  function draw(camera: Camera, maxSamples: number) {
    // A call to draw means accumulation has been invalidated. Cancel OIDN
    // before checking shader compilation: pipeline-affecting parameter changes
    // otherwise leave the previous asynchronous denoise alive while resources
    // and bind groups are being replaced.
    cancelOIDNDenoise();

    if (rayTracePass.isCompilingShader()) {
      isFirstFrame = true;
      sampleCount = 0;
      return true;
    }

    // Update the camera before compiling and sampling.
    const cameraChanged = rayTracePass.cameraChanged(camera);
    const resetAccumulation = cameraChanged || isFirstFrame;
    if (resetAccumulation) {
      denoiseValid = false;
      tileTimingGeneration++;
      elapsedTileTime = undefined;
      rayTracePass.setCamera(camera);
      (tileRenderWithPredict || tileRender).reset();

      // Reset
      isFirstFrame = false;
      sampleCount = 0;
    }

    rayTracePass.updatePipeline();

    if (rayTracePass.isCompilingShader() || !rayTracePass.isPipelineReady()) {
      isFirstFrame = true;
      sampleCount = 0;
      return true;
    }

    // Keep the last completed denoise visible while a static while-converging batch
    // accumulates, including the incomplete first sample after a scene edit.
    if (!preserveOIDNOutput || isFirstFrame) {
      clearOIDNOutput();
    }
    if (isPredictingFrame) {
      (tileRenderWithPredict || tileRender).reset();
      isPredictingFrame = false;
    }

    // Never enter a waiting prediction state while the shared timestamp
    // buffer is still being mapped. Render normally and retry the probe on a
    // later frame. The probe itself is also non-blocking: if readback fails or
    // is superseded, the renderer keeps using the conservative tile seed.
    if (
      offlineSamplesPerBatch === 0 &&
      tileRenderWithPredict &&
      needsUpdatePredicting &&
      timeQuery?.resultBuffer.mapState === 'unmapped'
    ) {
      (tileRenderWithPredict || tileRender).reset();
      isPredictingFrame = true;
      tileRenderWithPredict.needsUpdatePredicting();
      needsUpdatePredicting = false;
    }

    const frameSampleCount = sampleCount;
    _startRecordFrameTime(!resetAccumulation);
    const renderSampleTarget = maxSamples;
    const batchTarget = Math.min(
      renderSampleTarget,
      sampleCount + Math.max(offlineSamplesPerBatch, 1)
    );
    do {
      let {
        xIndex,
        yIndex,
        columns,
        rows,
        isFirstTile,
        isLastTile,
        samplesPerFrame
      } = (tileRenderWithPredict || tileRender).nextTile(elapsedTileTime);

      rayTraceOutputPass.setSampleTileGrid(columns, rows);

      if (offlineSamplesPerBatch > 0 && columns * rows === 1) {
        samplesPerFrame = batchTarget - sampleCount;
      } else if (!allowMultipleSamplesPerFrame) {
        samplesPerFrame = 1;
      }

      if (columns * rows === 1) {
        rayTracePass.setSampleTiles(1, 1, 0, 0);
        let samplesSubmitted = 0;
        while (
          samplesSubmitted < samplesPerFrame &&
          sampleCount < renderSampleTarget &&
          sampleCount < batchTarget
        ) {
          sample(sampleCount === 0, [1, 1]);
          sampleCount++;
          samplesSubmitted++;
        }
      } else {
        rayTracePass.setSampleTiles(columns, rows, xIndex, yIndex);
        sample(sampleCount === 0 && isFirstTile, [columns, rows]);
        if (isLastTile) sampleCount++;
      }
    } while (
      offlineSamplesPerBatch > 0 &&
      sampleCount < batchTarget &&
      sampleCount < renderSampleTarget
    );

    // Not displaying on screen for prediciting frame.
    if (isPredictingFrame) {
      // This hidden timing probe has not resolved the OIDN input textures.
      // Exclude it from progressive samples so a 1spp target cannot denoise
      // stale inputs, and clear its accumulation on the next visible sample.
      sampleCount = 0;
      return false;
    }

    if (sampleCount !== frameSampleCount && (!deferPostProcess || sampleCount >= renderSampleTarget)) {
      const encoder = device.createCommandEncoder();
      drawPostProcess(encoder, sampleCount >= renderSampleTarget, true);
    }
    if (sampleCount !== frameSampleCount) {
      onComplete();
      sampleRenderedCallback(
        sampleCount,
        frameSampleCount === 0,
        elapsedFrameTime
      );
    }

    return false;
  }

  function roundUp(a: number, b: number) {
    return Math.ceil(a / b) * b;
  }

  function _applyRenderResolution() {
    if (!screenWidth || !screenHeight) return;
    rayTracePass.useTarget(targetKey);
    const scale = previewMode ? adaptivePreviewScale : 1;
    const nextRenderWidth = roundUp(
      Math.max(1, Math.round(screenWidth * scale)),
      16
    );
    const nextRenderHeight = roundUp(
      Math.max(1, Math.round(screenHeight * scale)),
      16
    );
    if (nextRenderWidth === renderWidth && nextRenderHeight === renderHeight) {
      rayTracePass.setSize(nextRenderWidth, nextRenderHeight, screenWidth / screenHeight);
      return;
    }

    // OIDN retains the ray-trace output textures supplied at the start of a
    // tile sequence. Stop every phase (including Promise-chained follow-ups)
    // before those textures are replaced below.
    cancelOIDNDenoise();
    // Completed OIDN buffers use the previous image dimensions. Scene edits
    // may preserve them, but a resize must not copy them with the new stride.
    // The target retains its complete presentation texture through the resize.
    clearOIDNOutput();
    tileTimingGeneration++;
    renderWidth = nextRenderWidth;
    renderHeight = nextRenderHeight;
    (tileRenderWithPredict || tileRender).setSize(renderWidth, renderHeight);
    // Projection follows the displayed canvas, independent of preview/texture alignment.
    rayTracePass.setSize(renderWidth, renderHeight, screenWidth / screenHeight);
    rayTraceOutputPass.setSize(renderWidth, renderHeight);
    composePass.setSize(renderWidth, renderHeight);
    compositeDenoiseDisplayPass.setSize(renderWidth, renderHeight);
    const oidnImageSize = new Int32Array([renderWidth, renderHeight]);
    [
      oidnAlbedoEncodePass,
      oidnAlbedoDecodePass,
      oidnNormalSanitizePass
    ].forEach((pass) => {
      pass.setSize(renderWidth, renderHeight);
      pass.setUniform('imageSize', oidnImageSize);
    });
    bloomPass?.setSize(renderWidth, renderHeight);
    if (previewMode) onComplete(false);
    resolvedSamples = 0;
    // Timestamp and OIDN feedback can resize preview targets between render
    // calls. Their old sample count must not make Renderer treat the new,
    // empty targets as a completed frame and start denoising them.
    sampleCount = 0;
    resolvedSamples = 0;
    isFirstFrame = true;
  }

  function setSize(width: number, height: number) {
    if (width === screenWidth && height === screenHeight) {
      return;
    }
    screenWidth = width;
    screenHeight = height;
    _applyRenderResolution();
    outputPass.setSize(screenWidth, screenHeight);
    isFirstFrame = true;
  }
  function setMeshes(meshes: Mesh[], update?: Parameters<RenderingPipeline['setMeshes']>[1]) {
    const changed = rayTracePass.setMeshes(meshes, update);
    if (!changed) return false;
    tileTimingGeneration++;
    isFirstFrame = true;
    return true;
  }

  function setLights(lights: SceneLight[]) {
    tileTimingGeneration++;
    rayTracePass.setLights(lights);
    isFirstFrame = true;
  }

  function setBackground(background?: SceneBackground) {
    tileTimingGeneration++;
    rayTracePass.setBackground(background);
    const flatColor = Array.isArray(background) && background[3] >= 0.99999
      ? background
      : undefined;
    const flatBackgroundColor = flatColor
      ? [flatColor[0], flatColor[1], flatColor[2], 1]
      : [0, 0, 0, 0];
    composePass.setUniform('flatBackgroundColor', flatBackgroundColor);
    rawOutputPass.setUniform('flatBackgroundColor', flatBackgroundColor);
    isFirstFrame = true;
  }

  function setToneMappingParams(params: ToneMappingParams) {
    const newExposure = params.exposure ?? 1;
    const newToneMappingMode = {
      agx: 0,
      aces: 1,
      cineon: 2,
      reinhard: 3,
      linear: 4
    }[params.toneMapping ?? 'agx'] ?? 0;
    const newContrast = params.contrast ?? 1;
    const newSaturation = params.saturation ?? 1;
    const newTemperature = params.temperature ?? 0;
    const newTint = params.tint ?? 0;
    const newVignette = params.vignette ?? 0;
    if (
      newExposure === exposure &&
      newToneMappingMode === toneMappingMode &&
      newContrast === contrast &&
      newSaturation === saturation &&
      newTemperature === temperature &&
      newTint === tint &&
      newVignette === vignette
    ) return false;
    invalidateCompositeDenoise();
    exposure = newExposure;
    toneMappingMode = newToneMappingMode;
    contrast = newContrast;
    saturation = newSaturation;
    temperature = newTemperature;
    tint = newTint;
    vignette = newVignette;
    composePass.setUniform('exposure', exposure);
    composePass.setUniform('toneMappingParams', [toneMappingMode, vignette]);
    composePass.setUniform('colorGradingParams', [
      contrast,
      saturation,
      temperature,
      tint
    ]);
    return true;
  }

  function setHDROutputEnabled(enabled: boolean) {
    if (enabled === hdrOutputRequested) return false;
    invalidateCompositeDenoise();
    hdrOutputRequested = enabled;
    const wasActive = hdrOutputActive;

    if (enabled) {
      try {
        const configuration: HDRCanvasConfiguration = {
          device,
          format: 'rgba16float',
          alphaMode: presentationAlphaMode,
          colorSpace: 'srgb',
          toneMapping: { mode: 'extended' }
        };
        ctx.configure(configuration);
        const applied = ctx.getConfiguration?.();
        hdrOutputActive =
          applied?.format === 'rgba16float' &&
          applied.toneMapping?.mode === 'extended';
      } catch {
        hdrOutputActive = false;
      }
    } else {
      hdrOutputActive = false;
    }

    if (!hdrOutputActive && wasActive) {
      ctx.configure({
        device,
        format: standardPresentationFormat,
        alphaMode: presentationAlphaMode
      });
    } else if (enabled && !hdrOutputActive) {
      // Restore the regular surface after an ignored or rejected HDR request.
      ctx.configure({
        device,
        format: standardPresentationFormat,
        alphaMode: presentationAlphaMode
      });
    }

    currentPresentationFormat = hdrOutputActive
      ? 'rgba16float'
      : standardPresentationFormat;
    const nextComposeColorFormat: GPUTextureFormat = hdrOutputActive
      ? 'rgba16float'
      : 'rgba8unorm';
    if (nextComposeColorFormat !== composeColorFormat) {
      composeColorFormat = nextComposeColorFormat;
      composePass.setOutputParams({
        color: { format: composeColorFormat },
        denoiseColor: { format: 'rgba32float' }
      });

    }
    if (wasActive !== hdrOutputActive) {
      hdrPeakMeter?.reset();
    }
    compositeDenoiseDisplayPass.setOutputParams({ color: { format: composeColorFormat } });
    compositeDenoiseDisplayPass.setUniform('hdrOutputEnabled', hdrOutputActive ? 1 : 0);
    composePass.setUniform('hdrOutputEnabled', hdrOutputActive ? 1 : 0);
    return wasActive !== hdrOutputActive;
  }

  function _startRecordFrameTime(collectTileTiming: boolean) {
    const start = performance.now();
    const generation = tileTimingGeneration;
    const timedTileRender = tileRender;
    const scheduleFrame =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback: FrameRequestCallback) =>
            setTimeout(
              () => callback(performance.now()),
              0
            ) as unknown as number;
    scheduleFrame(() => {
      // TODO use timestamp from requestAnimationFrame may have negative value.
      elapsedFrameTime = Math.max(
        performance.now() - start - pageInvisibleTime,
        pageInvisibleTime > 0 ? 16 : 8
      );

      pageInvisibleTime = 0;
      if (
        generation === tileTimingGeneration &&
        timedTileRender === tileRender && !isFirstFrame
      ) {
        // Without GPU timestamps, discard the draw that follows a scene
        // update instead of feeding its preparation/compilation time back.
        elapsedTileTime = collectTileTiming ? elapsedFrameTime : undefined;
      }
    });
  }
  function _onPageVisiblilityChange() {
    if (typeof document !== 'undefined' && document.hidden) {
      pageLeaveTime = performance.now();
    } else {
      pageInvisibleTime = performance.now() - pageLeaveTime;
    }
  }

  function maxPreviewScale() {
    if (!oidnPreviewActive) return previewMaxResolutionScale;
    // Before the first measurement, start near one megapixel.
    oidnPreviewScaleLimit ??= Math.min(1, Math.max(
      MIN_OIDN_PREVIEW_SCALE,
      Math.sqrt(1e6 / Math.max(screenWidth * screenHeight, 1))
    ));
    return Math.min(previewMaxResolutionScale, oidnPreviewScaleLimit);
  }

  function updateOIDNPreviewScale(elapsedMs: number, measuredScale: number) {
    oidnPreviewScaleLimit = nextPreviewScale(
      measuredScale,
      elapsedMs,
      OIDN_PREVIEW_TARGET_MS,
      previewMaxResolutionScale,
      oidnPreviewScaleLimit ?? measuredScale,
      MIN_OIDN_PREVIEW_SCALE
    );
    if (previewMode && adaptivePreviewScale > oidnPreviewScaleLimit) {
      adaptivePreviewScale = oidnPreviewScaleLimit;
      _applyRenderResolution();
      isFirstFrame = true;
    }
  }

  /** Runs the built-in JNLM filter on the current composed image. */
  function performJNLMDenoise(
    denoiser: JNLMDenoiser,
    whileConverging: boolean
  ): Promise<boolean> {
    const generation = oidnGeneration;
    const timedPreview = whileConverging && previewMode;
    const startTime = performance.now();
    const startScale = adaptivePreviewScale;
    jnlmPass ??= new WGPUJNLMDenoisePass(device);
    const rayBuffers = rayTracePass.getOutputBuffer();
    const encoder = device.createCommandEncoder({ label: 'JNLM denoise' });
    const output = jnlmPass.encode(encoder, {
      width: renderWidth,
      height: renderHeight,
      accumulation: rayBuffers.shadowCatcher,
      normalAccumulation: rayBuffers.normal,
      color: composePass.getOutput('denoiseColor'),
      albedo: getFrameInput('albedo'),
      normal: getFrameInput('normal'),
      shadowCatcher: getFrameInput('shadowCatcher'),
      strength: denoiser.strength,
      shape: denoiser.shape
    });
    oidnComposedBuffer = copyOIDNOutput(
      encoder,
      { data: output, width: renderWidth, height: renderHeight },
      oidnComposedBuffer
    );
    oidnComposedLinear = true;
    denoiseValid = true;
    // The filter also smooths coverage, which carries catcher shadows and
    // transmissive alpha.
    compositeDenoiseDisplayPass.setUniform(
      'denoisedAlpha', +rayTracePass.needsDenoiseAlpha()
    );
    drawPostProcess(encoder, false);
    return device.queue.onSubmittedWorkDone().then(() => {
      const completed = generation === oidnGeneration;
      if (completed && timedPreview && previewMode) {
        updateOIDNPreviewScale(performance.now() - startTime, startScale);
      }
      return completed;
    });
  }

  function performOIDNDenoise(
    attachedDenoiser: OIDNWeb | JNLMDenoiser,
    alphaDenoiser: OIDNWeb | undefined,
    whileConverging = false
  ): Promise<boolean> {
    cancelOIDNDenoise();
    if (isFirstFrame || sampleCount < 1) return Promise.resolve(false);
    if (isJNLMDenoiser(attachedDenoiser)) {
      return performJNLMDenoise(attachedDenoiser, whileConverging);
    }
    const denoiser: OIDNWeb = attachedDenoiser;
    compositeDenoiseDisplayPass.setUniform('denoisedAlpha', 0);
    const generation = oidnGeneration;
    const timedPreview = whileConverging && previewMode;
    const startTime = performance.now();
    const startScale = adaptivePreviewScale;
    const size = { width: renderWidth, height: renderHeight };
    const convergingTileOptions = {
      ...(whileConverging ? {
        tileOverlap: 80,
        // Low-resolution interaction must finish as one low-latency frame;
        // otherwise continuous camera updates outrun a multi-tile denoise.
        // The settled full-resolution image uses bounded dynamic tiles so
        // 4K inference cannot allocate a whole-image U-Net activation set.
        wholeImage: previewMode
      } : {}),
      // A preview frame is one whole-image pass. Settled images can take many
      // tiles; oidn-web 0.5 runs those back to back by default, which starves
      // the page at 4K, so pace them to display frames instead.
      scheduling: whileConverging && previewMode
        ? 'event-loop' as const
        : 'animation-frame' as const
    };
    type AuxiliaryGuides = {
      albedo: OIDNWebGPUData;
      normal: OIDNWebGPUData;
    };

    async function denoiseAuxiliaryGuides(): Promise<
      AuxiliaryGuides | undefined
    > {
      const auxiliaryDenoisers = denoiser.auxiliaryDenoisers;
      // Prefilter sampled texture/normal detail for clean-aux weights. The
      // accumulated guides alone are not antialiased at silhouettes and
      // subpixel texture boundaries.
      if (!auxiliaryDenoisers) {
        return {
          albedo: {
            data: getFrameInput('albedo'),
            ...size
          },
          normal: {
            data: getFrameInput('normal'),
            ...size
          }
        };
      }
      if (generation !== oidnGeneration) return undefined;

      const encodeEncoder = device.createCommandEncoder();
      oidnAlbedoEncodePass.createPass(encodeEncoder, {
        albedo: {
          texture: getFrameInput('albedo'),
          channels: 4
        }
      });
      device.queue.submit([encodeEncoder.finish()]);

      let albedoOutput: OIDNWebGPUOutputData | undefined;
      await runOIDNPhase(generation, (finish, fail) =>
        auxiliaryDenoisers.albedo.tileExecute({
          ...convergingTileOptions,
          color: {
            data: oidnAlbedoEncodePass.getOutput('albedo'),
            ...size
          },
          done(output) {
            albedoOutput = output;
            finish();
          },
          error: fail
        })
      );
      if (generation !== oidnGeneration || !albedoOutput) return undefined;

      const decodeEncoder = device.createCommandEncoder();
      oidnAlbedoDecodePass.setUniform('preserveSurfaceTexture', +false);
      oidnAlbedoDecodePass.createPass(decodeEncoder, {
        albedo: { buffer: albedoOutput.data, channels: 4 },
        rawAlbedo: { texture: getFrameInput('albedo'), channels: 4 },
        rawNormal: { texture: getFrameInput('normal'), channels: 4 }
      });
      device.queue.submit([decodeEncoder.finish()]);

      let normalOutput: OIDNWebGPUOutputData | undefined;
      await runOIDNPhase(generation, (finish, fail) =>
        auxiliaryDenoisers.normal.tileExecute({
          ...convergingTileOptions,
          color: {
            data: getFrameInput('normal'),
            ...size
          },
          done(output) {
            normalOutput = output;
            finish();
          },
          error: fail
        })
      );
      if (generation !== oidnGeneration || !normalOutput) return undefined;

      const normalEncoder = device.createCommandEncoder();
      oidnNormalSanitizePass.createPass(normalEncoder, {
        normal: { buffer: normalOutput.data, channels: 4 }
      });
      // oidn-web generates one input shader for the resource type of the
      // color input. Convert both filtered guides to textures as well so the
      // composed color call never mixes textures and buffers.
      oidnAlbedoGuideTexture = prepareOIDNTexture(
        normalEncoder,
        oidnAlbedoDecodePass.getOutput('albedo'),
        oidnAlbedoGuideTexture
      );
      oidnNormalGuideTexture = prepareOIDNTexture(
        normalEncoder,
        oidnNormalSanitizePass.getOutput('normal'),
        oidnNormalGuideTexture
      );
      device.queue.submit([normalEncoder.finish()]);

      return {
        albedo: {
          data: oidnAlbedoGuideTexture!,
          ...size
        },
        normal: {
          data: oidnNormalGuideTexture!,
          ...size
        }
      };
    }

    function denoiseComposite(guides: AuxiliaryGuides): Promise<void> {
      if (generation !== oidnGeneration) return Promise.resolve();
      // Snapshot the complete raw composition; never feed a previous denoise
      // back into the network during progressive updates.
      return runOIDNPhase(generation, (finish, fail) =>
        denoiser.tileExecute({
          ...convergingTileOptions,
          color: { data: composePass.getOutput('denoiseColor'), ...size },
          albedo: guides.albedo,
          normal: guides.normal,
          progress(output, _tileData, _tile, currentIdx, totalIdx) {
            if (generation !== oidnGeneration) return;
            if (whileConverging && currentIdx + 1 < totalIdx) return;
            const encoder = device.createCommandEncoder();
            oidnComposedBuffer = copyOIDNOutput(encoder, output, oidnComposedBuffer);
            oidnComposedLinear = true;
            denoiseValid = true;
            drawPostProcess(encoder, false);
          },
          done(output) {
            if (generation === oidnGeneration) {
              const encoder = device.createCommandEncoder();
              oidnComposedBuffer = copyOIDNOutput(encoder, output, oidnComposedBuffer);
              oidnComposedLinear = true;
              denoiseValid = true;
              drawPostProcess(encoder, false);
            }
            finish();
          },
          error: fail
        })
      );
    }

    // Denoise alpha channel
    function denoiseComposed(): Promise<void> {
      if (!alphaDenoiser || generation !== oidnGeneration) {
        return Promise.resolve();
      }
      return runOIDNPhase(generation, (finish, fail) =>
        alphaDenoiser.tileExecute({
          ...convergingTileOptions,
          color: {
            data: oidnComposedLinear
              ? compositeDenoiseDisplayPass.getOutput('color')
              : composePass.getOutput('color'),
            ...size
          },
          denoiseAlpha: true,
          progress(output, _tileData, _tile, currentIdx, totalIdx) {
            if (generation !== oidnGeneration) return;
            // While-converging denoising keeps the previous complete frame (or the
            // fallback) visible while tiled inference is
            // running. Publishing the shared output buffer before its final
            // tile would expose uninitialized regions as black rectangles.
            if (whileConverging && currentIdx + 1 < totalIdx) return;
            const encoder = device.createCommandEncoder();
            oidnComposedBuffer = copyOIDNOutput(
              encoder,
              output,
              oidnComposedBuffer
            );
            oidnComposedLinear = false;
                    denoiseValid = true;
            drawPostProcess(encoder, false);
          },
          done(output) {
            if (generation === oidnGeneration) {
              const encoder = device.createCommandEncoder();
              oidnComposedBuffer = copyOIDNOutput(encoder, output, oidnComposedBuffer);
              oidnComposedLinear = false;
                        denoiseValid = true;
              drawPostProcess(encoder, false);
            }
            finish();
          },
          error: fail
        })
      );
    }

    return denoiseAuxiliaryGuides()
      .then(async (guides) => {
        if (guides && generation === oidnGeneration) {
          await denoiseComposite(guides);
        }
      })
      .then(() => {
        if (
          generation === oidnGeneration &&
          rayTracePass.needsDenoiseAlpha()
        ) {
          return denoiseComposed();
        }
      })
      .then(() => {
        const completed = generation === oidnGeneration;
        if (completed && timedPreview && previewMode) {
          updateOIDNPreviewScale(performance.now() - startTime, startScale);
        }
        return completed;
      });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', _onPageVisiblilityChange);
  }
  function dispose() {
    if (typeof document !== 'undefined') {
      document.removeEventListener(
        'visibilitychange',
        _onPageVisiblilityChange
      );
    }
    disposed = true;
    tileTimingGeneration++;
    cancelOIDNDenoise();
    // Target outputs and timestamp readbacks can still be referenced by the
    // queue. Cancel inference now; retire all GPU-owned target resources after
    // both submitted work and the pending timestamp mapping have completed.
    void Promise.all([
      device.queue.onSubmittedWorkDone().catch(() => undefined),
      diagnosticsReadbackPromise
    ]).then(() => {
      oidnComposedBuffer?.destroy();
      oidnComposedTexture?.destroy();
      retiredDenoiseTextures.forEach(texture => texture.destroy());
      oidnAlbedoGuideTexture?.destroy();
      oidnNormalGuideTexture?.destroy();
      jnlmPass?.dispose();
      outputPass.dispose();
      bloomPass?.dispose();
      composePass.dispose();
      rawOutputPass.dispose();
      readbackPass.dispose();
      compositeDenoiseDisplayPass.dispose();
      hdrPeakMeter?.dispose();
      oidnAlbedoEncodePass.dispose();
      oidnAlbedoDecodePass.dispose();
      oidnNormalSanitizePass.dispose();
      rayTraceOutputPass.dispose();
      timeQuery?.querySet.destroy();
      timeQuery?.resolveBuffer.destroy();
      timeQuery?.resultBuffer.destroy();
    });
  }

  function activate() {
    rayTracePass.useTarget(targetKey);
    if (renderWidth && renderHeight) rayTracePass.setSize(renderWidth, renderHeight, screenWidth / screenHeight);
    rayTracePass.setQuality({ bounces: previewMode ? Math.min(qualityBounces, previewBounces) : qualityBounces,
      bevel: !previewMode, dispersionWavelengths: previewMode ? 1 : 3,
      directLightCandidates: previewMode ? Math.min(qualityCandidates, 2) : qualityCandidates });
  }

  return {
    activate,
    invalidate() { isFirstFrame = true; },
    begin() {
      sampleCount = 0;
      isFirstFrame = true;
      resolvedSamples = 0;
      denoiseValid = false;
      isPredictingFrame = false;
      needsUpdatePredicting = offlineSamplesPerBatch === 0 && tileRenderWithPredict?.getLastTraceTime() === -1;
      (tileRenderWithPredict || tileRender).reset();
    },
    canCompleteSampleWithin(timeBudgetMs: number) {
      return (lastGpuTraceTiming?.estimatedFullFrameTimeMs ?? elapsedFrameTime) <= timeBudgetMs;
    },
    get presentationComplete() { return !!presentationTexture; },
    get presentationDenoised() { return presentationDenoised; },
    present() {
      if (!presentationTexture) return;
      const encoder = device.createCommandEncoder();
      _present(encoder, presentationTexture);
      device.queue.submit([encoder.finish()]);
    },
    getMemory() {
      const passes = [rayTraceOutputPass, composePass, compositeDenoiseDisplayPass,
        oidnAlbedoEncodePass, oidnAlbedoDecodePass, oidnNormalSanitizePass,
        rawOutputPass, readbackPass, outputPass, bloomPass, jnlmPass];
      return { width: renderWidth, height: renderHeight,
        bytes: rayTracePass.getTargetMemoryBytes(targetKey)
          + passes.reduce((sum, pass) => sum + (pass?.getMemoryBytes() ?? 0), 0)
          + (timeQuery ? timeQuery.resolveBuffer.size + timeQuery.resultBuffer.size : 0)
          + (oidnComposedBuffer?.size ?? 0)
          + [oidnComposedTexture, oidnAlbedoGuideTexture, oidnNormalGuideTexture, ...retiredDenoiseTextures]
            .reduce((sum, texture) => sum + textureBytes(texture), 0) };
    },
    isFirstFrame() {
      return isFirstFrame;
    },

    restartSamples() {
      cancelOIDNDenoise();
      preserveOIDNOutput = false;
      denoiseValid = false;
      presentationDenoised = false;
      resolvedSamples = 0;
      (tileRenderWithPredict || tileRender).reset();
      isPredictingFrame = false;
      isFirstFrame = true;
      sampleCount = 0;
    },

    draw,
    drawPostProcess() {
      const encoder = device.createCommandEncoder();
      drawPostProcess(encoder, true);
    },
    performOIDNDenoise,
    cancelOIDNDenoise,

    setMeshes,
    setTextureAtlasBudget(maxBytes: number) {
      const changed = rayTracePass.setTextureAtlasBudget(maxBytes);
      if (changed) isFirstFrame = true;
      return changed;
    },
    setLights,
    setSize,
    setBackground,
    setHDROutputEnabled,
    setToneMappingParams,

    readDepthSamples: (area) => rayTracePass.readDepthSamples(area),
    async readOutput(kind) {
      const width = renderWidth, height = renderHeight;
      const bytesPerRow = Math.ceil(width * 16 / 256) * 256;
      const buffer = device.createBuffer({
        size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const encoder = device.createCommandEncoder();
      const denoised = kind === 'denoised' && denoiseValid ? oidnComposedBuffer : undefined;
      if (kind === 'denoised' && !denoised) kind = 'hdr';
      const pass = kind === 'hdr' ? rawOutputPass : readbackPass;
      pass.setOutputParams({ color: { format: 'rgba32float' } });
      pass.setSize(width, height);
      if (denoised) {
        encoder.copyBufferToBuffer(denoised, 0, buffer, 0, width * height * 16);
      } else if (kind === 'hdr') {
        rawOutputPass.createPass(encoder, {colorTex: getFrameInput('color'), coverageTex: getFrameInput('albedo')});
      } else {
        readbackPass.createPass(encoder, {inputTex: getFrameInput(kind as 'albedo' | 'normal')});
      }
      if (!denoised) encoder.copyTextureToBuffer({texture: pass.getOutput('color')}, {buffer, bytesPerRow}, {width, height, depthOrArrayLayers: 1});
      device.queue.submit([encoder.finish()]);
      try {
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = new Float32Array(buffer.getMappedRange());
        const data = new Float32Array(width * height * 4);
        const stride = denoised ? width * 4 : bytesPerRow / 4;
        for (let y = 0; y < height; y++) data.set(mapped.subarray(y * stride, y * stride + width * 4), y * width * 4);
        return { data, width, height };
      } finally { buffer.unmap(); buffer.destroy(); }
    },

    setOIDNPreviewActive(active: boolean) {
      oidnPreviewActive = active;
      if (!active) presentationDenoised = false;
    },

    setPreserveOIDNOutput(preserve: boolean) {
      preserveOIDNOutput = preserve;
    },

    setAllowsMultipleSamplesPerFrame(allow: boolean) {
      allowMultipleSamplesPerFrame = allow;
    },
    setOfflineRenderOptions(options) {
      offlineSamplesPerBatch = Math.max(0, Math.round(options.samplesPerBatch));
      deferPostProcess = options.deferPostProcess;
      sampleSequenceOffset = Math.max(
        0,
        Math.round(options.sampleSequenceOffset)
      );
      if (offlineSamplesPerBatch > 0 && isPredictingFrame) {
        (tileRenderWithPredict || tileRender).reset();
        isPredictingFrame = false;
      }
      if (offlineSamplesPerBatch > 0) needsUpdatePredicting = false;
    },
    setVarianceMoments(enabled: boolean) {
      rayTracePass.setVarianceMoments(enabled);
    },
    setAdaptiveSamplingTargets(targets) {
      rayTracePass.setAdaptiveSamplingTargets(targets);
    },
    prepareOfflineAdaptiveSampling(options) {
      return rayTracePass.prepareOfflineAdaptiveSampling(options);
    },

    setBouncesAndClamping(bounces: number, clamping: number) {
      const qualityChanged = qualityBounces !== bounces;
      qualityBounces = bounces;
      let changed = rayTracePass.setBounce(bounces) || qualityChanged;
      changed = rayTracePass.setClamping(clamping) || changed;
      if (changed) {
        // Restart sample if bounces changed.
        invalidateTilePrediction();
        isFirstFrame = true;
      }
      return changed;
    },
    setDirectLightCandidates(candidates: number) {
      const qualityChanged = qualityCandidates !== candidates;
      qualityCandidates = candidates;
      const changed = rayTracePass.setDirectLightCandidates(candidates) || qualityChanged;
      if (changed) {
        invalidateTilePrediction();
        isFirstFrame = true;
      }
      return changed;
    },
    setAlphaBlendStrategy(strategy: AlphaBlendStrategy) {
      const changed = rayTracePass.setAlphaBlendStrategy(strategy);
      if (changed) {
        invalidateTilePrediction();
        isFirstFrame = true;
      }
      return changed;
    },
    setBevelSamples(samples: number) {
      const changed = rayTracePass.setBevelSamples(samples);
      if (changed) {
        invalidateTilePrediction();
        isFirstFrame = true;
      }
      return changed;
    },

    setSamplingPattern(pattern: SamplingPattern, maxSamples: number, sequenceSeed = 0) {
      const changed = rayTracePass.setSamplingPattern(pattern, maxSamples, sequenceSeed);
      if (changed) {
        // Restart accumulation when the sampling sequence changes.
        isFirstFrame = true;
      }
      return changed;
    },

    getTotalSamplesRendered() {
      return sampleCount;
    },

    getDiagnostics() {
      return {
        ...rayTracePass.getDiagnostics(),
        hdrPresentation: {
          requested: hdrOutputRequested,
          active: hdrOutputActive,
          peakDisplayValue: hdrOutputActive
            ? hdrPeakMeter?.getPeakDisplayValue()
            : undefined
        },
        gpuTraceTiming: lastGpuTraceTiming
      };
    },

    async flushDiagnostics() {
      await device.queue.onSubmittedWorkDone();
      await diagnosticsReadbackPromise;
    },

    setBloomParams({ intensity, threshold, radius }) {
      const changed =
        threshold !== bloomThreshold ||
        intensity !== bloomIntensity ||
        radius !== bloomRadius;
      if (changed) invalidateCompositeDenoise();
      bloomThreshold = threshold;
      bloomIntensity = intensity;
      bloomRadius = radius;
      return changed;
    },

    setShadowCatcherParams(color: ColorRGB, alpha: number) {
      const changed =
        color[0] !== shadowCatcherColor[0] ||
        color[1] !== shadowCatcherColor[1] ||
        color[2] !== shadowCatcherColor[2] ||
        alpha !== shadowCatcherAlpha;

      if (changed) {
        vec3.copy(shadowCatcherColor, color);
        shadowCatcherAlpha = alpha;

        composePass.setUniform('shadowCatcherColor', color);
        composePass.setUniform('shadowCatcherAlpha', alpha);
      }

      return changed;
    },

    setOnSampleRendered(
      cb: (
        sampleCount: number,
        isFirstFrame: boolean,
        frameTime: number
      ) => void
    ) {
      sampleRenderedCallback = cb;
    },
    setMaxTimePerTile(time: number) {
      maxTimePerTile = Math.max(time, 1);
      if (!previewMode) {
        tileRender.setDesiredMsPerTile(maxTimePerTile);
        tileRenderWithPredict?.setDesiredMsPerTile(maxTimePerTile);
      }
    },
    setMaxTiles(maxTiles: number) {
      tileRender.setMaxTiles(maxTiles);
      tileRenderWithPredict?.setMaxTiles(maxTiles);
    },
    setPreviewTargetFrameMs(time: number) {
      previewTargetFrameMs = Math.max(time, 1);
      if (previewMode) {
        tileRender.setDesiredMsPerTile(previewTargetFrameMs);
        tileRenderWithPredict?.setDesiredMsPerTile(previewTargetFrameMs);
      }
    },

    setPreviewParams({
      enabled,
      resolutionScale,
      bounces,
      idleDelayMs
    }) {
      const nextScale = Math.min(Math.max(resolutionScale, 0.25), 1);
      const nextBounces = Math.max(1, Math.round(bounces));
      const settingsChanged =
        previewMaxResolutionScale !== nextScale || previewBounces !== nextBounces;
      previewMaxResolutionScale = nextScale;
      previewBounces = nextBounces;
      if (previewMode && settingsChanged) {
        adaptivePreviewScale = Math.min(adaptivePreviewScale, previewMaxResolutionScale);
        tileRenderWithPredict?.needsUpdatePredicting();
        needsUpdatePredicting = offlineSamplesPerBatch === 0;
        isPredictingFrame = false;
        _applyRenderResolution();
        isFirstFrame = true;
      }
    },

    setTransmissiveOutputAlphaMin(alphaMin: number) {
      const changed = rayTracePass.setTransmissiveOutputAlphaMin(alphaMin);
      if (changed) {
        isFirstFrame = true;
      }
      return changed;
    },

    setOutput(nextOutput: RenderOutput) {
      if (output === nextOutput) return false;
      output = nextOutput;
      return true;
    },

    getDebugBVHData() {
      return rayTracePass.getDebugBVHData();
    },

    dispose
  } satisfies TargetPipeline;
}

function makeWGPURenderingPipeline(canvas: HTMLCanvasElement, device: GPUDevice, options: WGPURenderingPipelineOptions = {}): WGPURenderingPipeline & ResidentRenderingPipeline {
  const rayTracePass = new WGPURayTracePass(device);
  let configureContext = true;
  return makeProgressivePipeline(
    (targetOptions, onComplete) => {
      const target = makeWGPUAccumulationTarget(canvas, device, options, rayTracePass, targetOptions, onComplete, configureContext);
      configureContext = false;
      return target;
    },
    camera => rayTracePass.cameraChanged(camera),
    () => { void device.queue.onSubmittedWorkDone().catch(() => undefined).then(() => rayTracePass.dispose()); }
  ) as WGPURenderingPipeline & ResidentRenderingPipeline;
}

export default makeWGPURenderingPipeline;
