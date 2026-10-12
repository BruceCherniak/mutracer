import { makeProgressivePipeline, type AccumulationTargetOptions, type TargetPipeline } from './accumulationTarget.js';
import { readRgbaPixels } from './WebGLReadback.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import type { SamplingPattern } from './sampling.js';
import Camera from '../scene/Camera.js';
import Mesh from '../scene/Mesh.js';
import { SceneBackground, SceneLight } from '../scene/Scene.js';
import { ColorRGB } from '../types.js';
import { vec3 } from '../math.js';
import halton from './halton.js';
import { nextPreviewScale } from './util.js';
import { makeTileRender } from './TileRender.js';
import {
  RenderOutput,
  RenderingPipeline,
  ToneMappingParams
} from './RenderingPipeline.js';
import { constants, FrameBuffer, Renderer, Texture2D } from './webgl.js';
import { WebGLFullQuadPass } from './WebGLFullQuadPass.js';
import WebGLRayTracePass from './WebGLRayTracePass.js';
import { WebGLRayTraceOutputPass } from './WebGLRayTraceOutputPass.js';
import WebGLBloomPass from './WebGLBloomPass.js';
import {
  composeFragment,
  outputFragment
} from './glsl/webglPipeline.frag.js';
import { isJNLMDenoiser, type JNLMDenoiser } from './jnlm.js';
import { WebGLJNLMDenoisePass } from './WebGLJNLMDenoiser.js';

const wavelengths = [650, 510, 475];

/**
 * WebGL 2.0 counterpart of WGPURenderingPipeline.
 *
 * The frame is encoded as a fixed pass sequence. Each pass owns explicit
 * textures/FBOs, so no compositor graph or node lifecycle participates here.
 */
function makeWebGLAccumulationTarget(renderer: Renderer, rayTracePass: WebGLRayTracePass, targetOptions: AccumulationTargetOptions, onComplete: (complete?: boolean) => void) {
  let sampleRenderedCallback = (
    _sampleCount: number,
    _isFirstFrame: boolean,
    _frameTime: number
  ) => {};
  let allowMultipleSamplesPerFrame = false;
  let offlineSamplesPerBatch = 0;
  let deferPostProcess = false;
  let sampleSequenceOffset = 0;
  let sampleCount = 0;
  let elapsedFrameTime = 32;
  let elapsedTileTime: number | undefined;
  let tileTimingGeneration = 0;
  let isFirstFrame = true;
  let renderFailed = false;
  let renderWidth = 1;
  let renderHeight = 1;
  let screenWidth = 1;
  let screenHeight = 1;

  const previewMode = targetOptions.preview ?? false;
  const targetKey = {};
  let qualityBounces = 8;
  let resolvedSamples = 0;
  let presentationTexture: Texture2D | undefined;
  let presentationDenoised = false;
  let previewMaxResolutionScale = 0.5;
  let previewBounces = 2;
  let adaptivePreviewScale = 0.5;



  let maxTimePerTile = 21;
  let previewTargetFrameMs = 20;
  let maxTiles = Infinity;
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
  let output: RenderOutput = 'final';
  let pageLeaveTime = performance.now();
  let pageInvisibleTime = 0;
  const shadowCatcherColor = vec3.create();
  let shadowCatcherAlpha = 1;

  // Preview frames have a different resolution, bounce limit, and timing
  // target. Keep their measurements out of the full-resolution estimator so
  // returning from preview does not split a 4K sample into hundreds of tiles.
  const tileRender = makeTileRender(renderer.gl);
  tileRender.setDesiredMsPerTile(previewMode ? previewTargetFrameMs : maxTimePerTile);
  if (previewMode) tileRender.setMaxTiles(1);
  const rayTraceOutputPass = new WebGLRayTraceOutputPass(renderer);
  let bloomPass: WebGLBloomPass | undefined;

  const composePass = new WebGLFullQuadPass<
    'colorTex' | 'foregroundTex' | 'catcherBackgroundTex' | 'shadowCatcherTex' | 'bloomTex',
    'color'
  >('compose', renderer, {
    shader: composeFragment,
    outputs: ['color'],
    outputParams: { color: { type: constants.UNSIGNED_BYTE } }
  });
  composePass.setUniforms({
    exposure,
    shadowCatcherColor,
    shadowCatcherAlpha,
    shadowCatcherEnabled: 0,
    bloomIntensity: 0,
    toneMappingMode,
    contrast,
    saturation,
    temperature,
    tint,
    vignette,
    outputMode: 0,
    sRGBOutput: 1
  });

  const outputPass = new WebGLFullQuadPass<
    'colorTex' | 'colorDenoisedTex',
    'color'
  >('output', renderer, { shader: outputFragment, outputs: ['color'] });
  outputPass.setRenderToScreen();
  const rawReadFrameBuffer = new FrameBuffer();

  // Built-in JNLM denoising. WebGL runs it synchronously inside the
  // post-process, between composition and output.
  let jnlmPass: WebGLJNLMDenoisePass | undefined;
  let pendingDenoiser: JNLMDenoiser | undefined;
  let denoisedTexture: Texture2D | undefined;
  // Keep the last denoised image visible while while-converging batches
  // accumulate (see RenderingPipeline.setPreserveOIDNOutput).
  let preserveDenoisedOutput = false;

  function updateSeed(useJitter: boolean) {
    const sequenceSample = sampleCount + sampleSequenceOffset;
    const jitterX = useJitter ? halton(sequenceSample, 2) - 0.5 : 0;
    const jitterY = useJitter ? halton(sequenceSample, 3) - 0.5 : 0;
    rayTracePass.setJitter(jitterX / renderWidth, jitterY / renderHeight);
  }

  function traceSample(
    clear: boolean,
    tile: { x: number; y: number; width: number; height: number }
  ) {
    rayTracePass.setSampleCount(sampleCount + sampleSequenceOffset);
    rayTracePass.setSampleSequenceOffset(sampleSequenceOffset);
    updateSeed(true);
    if (rayTracePass.hasDispersion()) {
      if (previewMode) {
        // A positive wavelength enables stochastic hero-wavelength sampling
        // in the shader. Preview traces one random RGB channel per pixel.
        rayTracePass.setWavelength(wavelengths[0]);
        rayTracePass.createPass(clear, tile);
      } else {
        wavelengths.forEach((wavelength, index) => {
          rayTracePass.setWavelength(wavelength);
          rayTracePass.createPass(clear && index === 0, tile, index > 0);
        });
      }
    } else {
      rayTracePass.setWavelength(0);
      rayTracePass.createPass(clear, tile);
    }
  }

  function drawPostProcess(_forceNeedsDenoise = false, resolve = false) {
    if (resolve) resolvedSamples = sampleCount;
    if (resolvedSamples === 0) return;
    if (resolve) {
      rayTraceOutputPass.setSampleCount(sampleCount);
      rayTraceOutputPass.createPass(rayTracePass);
    }

    const colorTexture = rayTraceOutputPass.getOutput('color');
    const bloomEnabled = bloomIntensity > 0;
    const samplesSkipped = sampleCount < 10 || sampleCount % 10 > 0;
    const needsUpdateBloom = bloomEnabled && !samplesSkipped;
    let currentBloomIntensity = bloomIntensity;
    if (needsUpdateBloom) {
      bloomPass ||= new WebGLBloomPass(renderer);
      bloomPass.setSize(renderWidth, renderHeight);
      bloomPass.setBrightThreshold(bloomThreshold);
      bloomPass.setRadius(bloomRadius);
      bloomPass.createPass(colorTexture);
    } else if (bloomEnabled && sampleCount < 10) {
      currentBloomIntensity = 0;
    }

    composePass.setUniforms({
      bloomIntensity: currentBloomIntensity,
      shadowCatcherEnabled: +rayTracePass.hasShadowCatcher(),
      outputMode: output === 'shadow' ? 1 : 0
    });
    composePass.createPass({
      colorTex: colorTexture,
      foregroundTex: rayTraceOutputPass.getOutput('foreground'),
      catcherBackgroundTex: rayTraceOutputPass.getOutput('catcherBackground'),
      shadowCatcherTex: rayTraceOutputPass.getOutput('shadowCatcher'),
      bloomTex:
        bloomEnabled && bloomPass
          ? bloomPass.getOutput()
          : renderer.emptyTexture
    });

    if (pendingDenoiser) {
      jnlmPass ??= new WebGLJNLMDenoisePass(renderer);
      denoisedTexture = jnlmPass.render({
        width: renderWidth,
        height: renderHeight,
        moments: rayTracePass.getOutput('moments'),
        catcherMoments: rayTracePass.hasShadowCatcher()
          ? rayTracePass.getOutput('catcherMoments')
          : undefined,
        color: composePass.getOutput('color'),
        albedo: rayTraceOutputPass.getOutput('albedo'),
        normal: rayTraceOutputPass.getOutput('normal'),
        shadowCatcher: rayTraceOutputPass.getOutput('shadowCatcher'),
        strength: pendingDenoiser.strength,
        shape: pendingDenoiser.shape
      });
      pendingDenoiser = undefined;
    }

    let displayTexture =
      (output === 'final' && denoisedTexture) || composePass.getOutput('color');
    if (output === 'normal' || output === 'albedo') {
      displayTexture = rayTraceOutputPass.getOutput(output);
    } else if (output === 'shadowCatcher') {
      displayTexture = rayTraceOutputPass.getOutput('shadowCatcher');
    }
    if (presentationTexture !== displayTexture) {
      for (const pass of [composePass, rayTraceOutputPass, jnlmPass]) {
        pass?.retainOutput(displayTexture);
        if (presentationTexture) pass?.releaseOutput(presentationTexture);
      }
    }
    presentationTexture = displayTexture;
    presentationDenoised = output === 'final' && !!denoisedTexture;

  }

  function startRecordFrameTime(collectTileTiming: boolean) {
    const start = performance.now();
    const generation = tileTimingGeneration;
    const timedTileRender = tileRender;
    requestAnimationFrame(() => {
      elapsedFrameTime = Math.max(
        performance.now() - start - pageInvisibleTime,
        pageInvisibleTime > 0 ? 16 : 8
      );
      pageInvisibleTime = 0;
      if (
        generation === tileTimingGeneration &&
        timedTileRender === tileRender && !isFirstFrame
      ) {
        elapsedTileTime = collectTileTiming && renderer.isAllProgramCompiled()
          ? elapsedFrameTime : undefined;
      }
    });
  }

  function draw(camera: Camera, maxSamples: number) {
    if (rayTracePass.isInvalid() || renderFailed) return false;
    if (!renderer.isAllProgramCompiled()) {
      isFirstFrame = true;
      sampleCount = 0;
      tileRender.reset();
      return true;
    }

    const resetAccumulation = rayTracePass.cameraChanged(camera) || isFirstFrame;
    if (resetAccumulation) {
      tileTimingGeneration++;
      elapsedTileTime = undefined;
      rayTracePass.setCamera(camera);
      tileRender.reset();
      sampleCount = 0;
      isFirstFrame = false;
    }
    if (sampleCount >= maxSamples) {
      drawPostProcess(true);
      return false;
    }
    // New samples make the denoised image stale.
    if (!preserveDenoisedOutput || resetAccumulation) denoisedTexture = undefined;

    // The first draw after an update lazily prepares scene data and shaders.
    // Keep its wall time for reporting, but not for estimating tile throughput.
    startRecordFrameTime(!resetAccumulation);
    const frameSampleCount = sampleCount;
    let tile = tileRender.nextTile(elapsedTileTime);
    if (offlineSamplesPerBatch > 0 && tile.isFirstTile && tile.isLastTile) {
      tile.samplesPerFrame = offlineSamplesPerBatch;
    } else if (
      !allowMultipleSamplesPerFrame ||
      !(tile.isFirstTile && tile.isLastTile)
    ) {
      tile.samplesPerFrame = 1;
    }

    try {
      for (let i = 0; i < tile.samplesPerFrame && sampleCount < maxSamples; i++) {
        traceSample(sampleCount === 0 && tile.isFirstTile, {
          x: tile.x,
          y: tile.y,
          width: tile.tileWidth,
          height: tile.tileHeight
        });
        if (tile.isLastTile) sampleCount++;
      }
      if (sampleCount !== frameSampleCount && (!deferPostProcess || sampleCount >= maxSamples)) {
        drawPostProcess(sampleCount >= maxSamples, true);
      }
    } catch (error) {
      console.error(error);
      renderFailed = true;
      return false;
    }

    if (sampleCount !== frameSampleCount) {
      if (renderer.isAllProgramCompiled()) onComplete();
      sampleRenderedCallback(
        sampleCount,
        frameSampleCount === 0,
        elapsedFrameTime
      );
      if (previewMode && sampleCount > 1) {
        const nextScale = nextPreviewScale(
          adaptivePreviewScale,
          elapsedFrameTime,
          previewTargetFrameMs,
          previewMaxResolutionScale
        );
        if (nextScale !== adaptivePreviewScale) {
          adaptivePreviewScale = nextScale;
          applyRenderResolution();
        }
      }
    }
    return !renderer.isAllProgramCompiled();
  }

  function applyRenderResolution() {
    rayTracePass.useTarget(targetKey);
    // At 720p and below, reallocating the whole render graph costs more than
    // reducing the ray count. Keep the native resolution and rely on the
    // preview bounce/bevel reductions instead.
    const useScaledPreview =
      previewMode && screenWidth * screenHeight > 1000000;
    const scale = useScaledPreview ? adaptivePreviewScale : 1;
    const nextWidth = Math.max(1, Math.round(screenWidth * scale));
    const nextHeight = Math.max(1, Math.round(screenHeight * scale));
    rayTracePass.setSize(nextWidth, nextHeight, screenWidth / screenHeight);
    if (nextWidth === renderWidth && nextHeight === renderHeight) return;
    renderWidth = nextWidth;
    renderHeight = nextHeight;
    tileRender.setSize(renderWidth, renderHeight);
    rayTraceOutputPass.setSize(renderWidth, renderHeight);
    composePass.setSize(renderWidth, renderHeight);
    bloomPass?.setSize(renderWidth, renderHeight);
    sampleCount = 0;
    resolvedSamples = 0;
    isFirstFrame = true;
    if (previewMode) onComplete(false);
  }

  function setSize(width: number, height: number) {
    width = Math.max(1, width);
    height = Math.max(1, height);
    if (width === screenWidth && height === screenHeight) return;
    screenWidth = width;
    screenHeight = height;
    renderer.resize(screenWidth, screenHeight);
    outputPass.setSize(screenWidth, screenHeight);
    applyRenderResolution();
    sampleCount = 0;
    isFirstFrame = true;
  }

  function onVisibilityChange() {
    if (document.hidden) pageLeaveTime = performance.now();
    else pageInvisibleTime = performance.now() - pageLeaveTime;
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function activate() {
    rayTracePass.useTarget(targetKey);
    rayTracePass.setSize(renderWidth, renderHeight, screenWidth / screenHeight);
    rayTracePass.setQuality({ bounces: previewMode ? Math.min(qualityBounces, previewBounces) : qualityBounces,
      bevel: !previewMode, dispersionWavelengths: previewMode ? 1 : 3, directLightCandidates: 1 });
  }

  return {
    activate,
    invalidate() { isFirstFrame = true; },
    begin() {
      if (previewMode) { adaptivePreviewScale = previewMaxResolutionScale; applyRenderResolution(); }
      tileRender.reset();
      isFirstFrame = true;
      sampleCount = 0;
      resolvedSamples = 0;
      denoisedTexture = undefined;
    },
    canCompleteSampleWithin(timeBudgetMs: number) { return elapsedFrameTime <= timeBudgetMs; },
    get presentationComplete() { return !!presentationTexture; },
    get presentationDenoised() { return presentationDenoised; },
    present() {
      if (!presentationTexture) return;
      outputPass.setUniform('denoisedPercent', 0);
      outputPass.createPass({ colorTex: presentationTexture, colorDenoisedTex: presentationTexture });
    },
    getMemory() {
      return { width: renderWidth, height: renderHeight,
        bytes: rayTracePass.getTargetMemoryBytes(targetKey)
          + rayTraceOutputPass.getMemoryBytes() + composePass.getMemoryBytes()
          + (bloomPass?.getMemoryBytes() ?? 0) + (jnlmPass?.getMemoryBytes() ?? 0) };
    },
    isFirstFrame: () => isFirstFrame,
    restartSamples(_preserveTemporalHistory = false) {
      tileRender.reset();
      isFirstFrame = true;
      sampleCount = 0;
      denoisedTexture = undefined;
      preserveDenoisedOutput = false;
    },
    /** Denoises the current image. WebGL only supports the built-in JNLM filter. */
    performOIDNDenoise(denoiser: unknown): Promise<boolean> {
      if (!isJNLMDenoiser(denoiser)) {
        return Promise.reject(new Error('OIDN requires a WebGPU renderer.'));
      }
      if (isFirstFrame || sampleCount < 1) return Promise.resolve(false);
      pendingDenoiser = denoiser;
      drawPostProcess(true);
      return Promise.resolve(true);
    },
    cancelOIDNDenoise() {
      pendingDenoiser = undefined;
    },
    setPreserveOIDNOutput(preserve: boolean) {
      preserveDenoisedOutput = preserve;
    },
    draw,
    drawPostProcess: () => drawPostProcess(true),
    setMeshes(meshes: Mesh[], update?: Parameters<RenderingPipeline['setMeshes']>[1]) {
      const changed = rayTracePass.setMeshes(meshes, update);
      if (!changed) return false;
      isFirstFrame = true;
      return true;
    },
    setTextureAtlasBudget(maxBytes: number) {
      const changed = rayTracePass.setTextureAtlasBudget(maxBytes);
      if (changed) isFirstFrame = true;
      return changed;
    },
    setLights(lights: SceneLight[]) {
      rayTracePass.setLights(lights);
      isFirstFrame = true;
    },
    setBackground(background?: SceneBackground) {
      rayTracePass.setBackground(background);
      isFirstFrame = true;
    },
    setSize,
    setToneMappingParams(params: ToneMappingParams) {
      const nextExposure = params.exposure ?? 1;
      const nextToneMappingMode = {
        agx: 0,
        aces: 1,
        cineon: 2,
        reinhard: 3,
        linear: 4
      }[params.toneMapping ?? 'agx'] ?? 0;
      const nextContrast = params.contrast ?? 1;
      const nextSaturation = params.saturation ?? 1;
      const nextTemperature = params.temperature ?? 0;
      const nextTint = params.tint ?? 0;
      const nextVignette = params.vignette ?? 0;
      if (
        nextExposure === exposure &&
        nextToneMappingMode === toneMappingMode &&
        nextContrast === contrast &&
        nextSaturation === saturation &&
        nextTemperature === temperature &&
        nextTint === tint &&
        nextVignette === vignette
      ) return false;
      exposure = nextExposure;
      toneMappingMode = nextToneMappingMode;
      contrast = nextContrast;
      saturation = nextSaturation;
      temperature = nextTemperature;
      tint = nextTint;
      vignette = nextVignette;
      composePass.setUniforms({
        exposure,
        toneMappingMode,
        contrast,
        saturation,
        temperature,
        tint,
        vignette
      });
      return true;
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
    },
    setVarianceMoments(_enabled: boolean) {},
    setAdaptiveSamplingTargets(_targets) {},
    async prepareOfflineAdaptiveSampling(_options) {
      return undefined;
    },
    setBouncesAndClamping(bounces: number, clamping: number) {
      const qualityChanged = qualityBounces !== bounces;
      qualityBounces = bounces;
      let changed = rayTracePass.setBounce(Math.max(1, bounces)) || qualityChanged;
      changed = rayTracePass.setClamping(clamping) || changed;
      if (changed) isFirstFrame = true;
      return changed;
    },
    // Multi-candidate light RIS is currently a WebGPU path-tracing feature.
    setDirectLightCandidates(_candidates: number) {
      return false;
    },
    setAlphaBlendStrategy(_strategy) {
      return false;
    },
    setBevelSamples(samples: number) {
      const changed = rayTracePass.setBevelSamples(samples);
      if (changed) isFirstFrame = true;
      return changed;
    },
    setSamplingPattern(pattern: SamplingPattern, maxSamples: number, sequenceSeed = 0) {
      const changed = rayTracePass.setSamplingPattern(pattern, maxSamples, sequenceSeed);
      if (changed) isFirstFrame = true;
      return changed;
    },
    getTotalSamplesRendered: () => sampleCount,
    getDiagnostics: () => ({...rayTracePass.getDiagnostics(), shaderCompilation: renderer.getShaderCompilationDiagnostics()}),
    flushDiagnostics: async () => {},
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
    setBloomParams({ intensity, threshold, radius }) {
      const changed =
        intensity !== bloomIntensity ||
        threshold !== bloomThreshold ||
        radius !== bloomRadius;
      bloomIntensity = intensity;
      bloomThreshold = threshold;
      bloomRadius = radius;
      return changed;
    },
    setOnSampleRendered(cb) {
      sampleRenderedCallback = cb;
    },
    setMaxTimePerTile(time: number) {
      maxTimePerTile = Math.max(time, 1);
      if (!previewMode) tileRender.setDesiredMsPerTile(maxTimePerTile);
    },
    setMaxTiles(nextMaxTiles: number) {
      maxTiles = nextMaxTiles;
      if (!previewMode) tileRender.setMaxTiles(maxTiles);
    },
    setPreviewTargetFrameMs(time: number) {
      previewTargetFrameMs = Math.max(time, 1);
      if (previewMode) tileRender.setDesiredMsPerTile(previewTargetFrameMs);
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
        previewMaxResolutionScale !== nextScale ||
        previewBounces !== nextBounces;
      previewMaxResolutionScale = nextScale;
      previewBounces = nextBounces;
      if (previewMode && settingsChanged) {
        adaptivePreviewScale = Math.min(adaptivePreviewScale, previewMaxResolutionScale);
        applyRenderResolution();
        isFirstFrame = true;
      }
    },
    setTransmissiveOutputAlphaMin(alphaMin: number) {
      const changed = rayTracePass.setTransmissiveOutputAlphaMin(alphaMin);
      if (changed) isFirstFrame = true;
      return changed;
    },
    setOutput(nextOutput: RenderOutput) {
      if (output === nextOutput) return false;
      output = nextOutput;
      return true;
    },
    readDepthSamples: (area) => rayTracePass.readDepthSamples(area),
    async readOutput(kind) {
      if (kind === 'denoised' && !denoisedTexture) kind = 'hdr';
      const texture = kind === 'denoised' ? denoisedTexture! : rayTraceOutputPass.getOutput(kind === 'hdr' ? 'color' : kind);
      rawReadFrameBuffer.bind(renderer, [texture]);
      return {data: readRgbaPixels(renderer.gl, renderWidth, renderHeight, kind === 'albedo' || kind === 'normal'), width: renderWidth, height: renderHeight};
    },
    getDebugBVHData() {
      const debugData = rayTracePass.getDebugBVHData();
      return Promise.resolve(debugData);
    },
    dispose() {
      document.removeEventListener('visibilitychange', onVisibilityChange);

      rayTraceOutputPass.dispose();
      bloomPass?.dispose();
      jnlmPass?.dispose();
      composePass.dispose();
      outputPass.dispose();
      rawReadFrameBuffer.dispose(renderer);
    }
  } satisfies TargetPipeline;
}

export function makeWebGLRenderingPipeline(renderer: Renderer) {
  const rayTracePass = new WebGLRayTracePass(renderer);
  return makeProgressivePipeline(
    (options, onComplete) => makeWebGLAccumulationTarget(renderer, rayTracePass, options, onComplete),
    camera => rayTracePass.cameraChanged(camera), () => rayTracePass.dispose()
  );
}

export default makeWebGLRenderingPipeline;
