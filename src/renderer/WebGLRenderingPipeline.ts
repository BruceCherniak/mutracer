import type { SamplingPattern } from './sampling';
import Camera from '../scene/Camera';
import Mesh from '../scene/Mesh';
import { Scene, SceneBackground, SceneLight } from '../scene/Scene';
import { ColorRGB } from '../types';
import { vec3 } from '../math';
import halton from './hanton';
import { makeTileRender } from './TileRender';
import {
  RenderOutput,
  RenderingPipeline,
  ToneMappingParams
} from './RenderingPipeline';
import { constants, FrameBuffer, Renderer, Texture2D } from './webgl';
import { WebGLFullQuadPass } from './WebGLFullQuadPass';
import WebGLRayTracePass from './WebGLRayTracePass';
import { WebGLRayTraceOutputPass } from './WebGLRayTraceOutputPass';
import WebGLBloomPass from './WebGLBloomPass';
import {
  composeFragment,
  outputFragment
} from './glsl/webglPipeline.frag';

const wavelengths = [650, 510, 475];

/**
 * WebGL 2.0 counterpart of WGPURenderingPipeline.
 *
 * The frame is encoded as a fixed pass sequence. Each pass owns explicit
 * textures/FBOs, so no compositor graph or node lifecycle participates here.
 */
export function makeWebGLRenderingPipeline(renderer: Renderer) {
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
  let interactivePreviewEnabled = true;
  let previewMode = false;
  let previewResolutionScale = 0.5;
  let previewBounces = 2;
  let adaptivePreviewScale = 0.5;
  let previewIdleDelayMs = 150;
  let lastInteractionTime = -Infinity;
  let previewSamplePending = false;
  let maxTimePerTile = 21;
  let maxTimePreview = 20;
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
  let overlay: Scene['overlay'];
  let pageLeaveTime = performance.now();
  let pageInvisibleTime = 0;
  const shadowCatcherColor = vec3.create();
  let shadowCatcherAlpha = 1;

  // Preview frames have a different resolution, bounce limit, and timing
  // target. Keep their measurements out of the full-resolution estimator so
  // returning from preview does not split a 4K sample into hundreds of tiles.
  const finalTileRender = makeTileRender(renderer.gl);
  const previewTileRender = makeTileRender(renderer.gl);
  let tileRender = finalTileRender;
  previewTileRender.setDesiredMsPerTile(maxTimePreview);
  previewTileRender.setMaxTiles(1);
  const rayTracePass = new WebGLRayTracePass(renderer);
  const rayTraceOutputPass = new WebGLRayTraceOutputPass(renderer);
  let bloomPass: WebGLBloomPass | undefined;

  const composePass = new WebGLFullQuadPass<
    'colorTex' | 'shadowCatcherTex' | 'bloomTex',
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
    'colorTex' | 'colorDenoisedTex' | 'overlayTex',
    'color'
  >('output', renderer, { shader: outputFragment, outputs: ['color'] });
  outputPass.setRenderToScreen();
  const overlayTexture = new Texture2D({
    premultiplyAlpha: false,
    flipY: true,
    minFilter: constants.LINEAR,
    magFilter: constants.LINEAR
  });

  const rawReadFrameBuffer = new FrameBuffer();

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

  function drawPostProcess(_forceNeedsDenoise = false) {
    if (sampleCount === 0) return;

    rayTraceOutputPass.setSampleCount(sampleCount);
    rayTraceOutputPass.createPass(rayTracePass);

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
      shadowCatcherTex: rayTraceOutputPass.getOutput('shadowCatcher'),
      bloomTex:
        bloomEnabled && bloomPass
          ? bloomPass.getOutput()
          : renderer.emptyTexture
    });

    let displayTexture = composePass.getOutput('color');
    if (output === 'normal' || output === 'albedo') {
      displayTexture = rayTraceOutputPass.getOutput(output);
    } else if (output === 'shadowCatcher') {
      displayTexture = rayTraceOutputPass.getOutput('shadowCatcher');
    }
    outputPass.setUniform('denoisedPercent', 0);
    outputPass.setUniform(
      'overlayPos',
      overlay
        ? [
            overlay.x / screenWidth,
            (screenHeight - overlay.y - overlay.height) / screenHeight,
            overlay.width / screenWidth,
            overlay.height / screenHeight
          ]
        : [1e5, 1e5, 0, 0]
    );
    outputPass.createPass({
      colorTex: displayTexture,
      colorDenoisedTex: displayTexture,
      overlayTex: overlay ? overlayTexture : renderer.emptyTexture
    });
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
      if (!deferPostProcess || sampleCount >= maxSamples) {
        drawPostProcess(sampleCount >= maxSamples);
      }
    } catch (error) {
      console.error(error);
      renderFailed = true;
      return false;
    }

    if (sampleCount !== frameSampleCount) {
      if (renderer.isAllProgramCompiled()) previewSamplePending = false;
      sampleRenderedCallback(
        sampleCount,
        frameSampleCount === 0,
        elapsedFrameTime
      );
      if (previewMode && sampleCount > 1) {
        const rawScale =
          adaptivePreviewScale *
          Math.sqrt(maxTimePreview / Math.max(elapsedFrameTime, 1));
        const nextScale = Math.min(
          previewResolutionScale,
          Math.max(0.25, Math.round(rawScale * 8) / 8)
        );
        if (Math.abs(nextScale - adaptivePreviewScale) >= 0.12) {
          adaptivePreviewScale = nextScale;
          applyRenderResolution();
        }
      }
    }
    return !renderer.isAllProgramCompiled();
  }

  function applyRenderResolution() {
    // At 720p and below, reallocating the whole render graph costs more than
    // reducing the ray count. Keep the native resolution and rely on the
    // preview bounce/bevel reductions instead.
    const useScaledPreview =
      previewMode && screenWidth * screenHeight > 1000000;
    const scale = useScaledPreview ? adaptivePreviewScale : 1;
    const nextWidth = Math.max(1, Math.round(screenWidth * scale));
    const nextHeight = Math.max(1, Math.round(screenHeight * scale));
    if (nextWidth === renderWidth && nextHeight === renderHeight) return;
    renderWidth = nextWidth;
    renderHeight = nextHeight;
    tileRender.setSize(renderWidth, renderHeight);
    rayTracePass.setSize(renderWidth, renderHeight);
    rayTraceOutputPass.setSize(renderWidth, renderHeight);
    composePass.setSize(renderWidth, renderHeight);
    bloomPass?.setSize(renderWidth, renderHeight);
    sampleCount = 0;
    isFirstFrame = true;
  }

  function setPreviewMode(nextPreviewMode: boolean) {
    if (previewMode === nextPreviewMode) return false;
    previewMode = nextPreviewMode;
    if (!previewMode) previewSamplePending = false;
    if (previewMode) adaptivePreviewScale = previewResolutionScale;
    tileRender = previewMode ? previewTileRender : finalTileRender;
    rayTracePass.setPreviewMode(previewMode, previewBounces);
    applyRenderResolution();
    // applyRenderResolution can be a no-op when the configured preview scale
    // is 1, but the newly selected controller still needs the current size.
    tileRender.setSize(renderWidth, renderHeight);
    sampleCount = 0;
    isFirstFrame = true;
    return true;
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

  return {
    isFirstFrame: () => isFirstFrame,
    restartSamples(_preserveTemporalHistory = false) {
      tileRender.reset();
      isFirstFrame = true;
      sampleCount = 0;
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
        linear: 4,
        // Tony McMapface and histogram exposure are WebGPU-only. Preserve a
        // deterministic fallback for callers that switch rendering backends.
        neutral: 0
      }[params.toneMapping ?? 'agx'];
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
    needsRestartSample(camera: Camera, sceneChanged = false) {
      const cameraChanged = rayTracePass.cameraChanged(camera);
      const now = performance.now();
      if (cameraChanged || (interactivePreviewEnabled && sceneChanged)) {
        lastInteractionTime = now;
        if (interactivePreviewEnabled) {
          setPreviewMode(true);
          previewSamplePending = true;
        }
        return true;
      }
      if (
        previewMode && !previewSamplePending &&
        now - lastInteractionTime >= previewIdleDelayMs
      ) {
        setPreviewMode(false);
        return true;
      }
      return false;
    },

    isPreviewMode() {
      return previewMode;
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
      let changed = rayTracePass.setBounce(Math.max(1, bounces));
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
    getDiagnostics: () => rayTracePass.getDiagnostics(),
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
      finalTileRender.setDesiredMsPerTile(maxTimePerTile);
    },
    setMaxTiles(nextMaxTiles: number) {
      maxTiles = nextMaxTiles;
      finalTileRender.setMaxTiles(maxTiles);
    },
    setMaxTimePreview(time: number) {
      maxTimePreview = Math.max(time, 1);
      previewTileRender.setDesiredMsPerTile(maxTimePreview);
    },
    setInteractivePreviewParams({
      enabled,
      resolutionScale,
      bounces,
      idleDelayMs
    }) {
      const nextScale = Math.min(Math.max(resolutionScale, 0.25), 1);
      const nextBounces = Math.max(1, Math.round(bounces));
      const settingsChanged =
        previewResolutionScale !== nextScale ||
        previewBounces !== nextBounces;
      interactivePreviewEnabled = enabled;
      previewResolutionScale = nextScale;
      previewBounces = nextBounces;
      previewIdleDelayMs = Math.max(0, idleDelayMs);
      if (!enabled && previewMode) {
        setPreviewMode(false);
      } else if (previewMode && settingsChanged) {
        adaptivePreviewScale = Math.min(
          adaptivePreviewScale,
          previewResolutionScale
        );
        rayTracePass.setPreviewMode(true, previewBounces);
        applyRenderResolution();
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
    setOverlay(nextOverlay: Scene['overlay']) {
      if (overlay === nextOverlay) return false;
      overlay = nextOverlay;
      if (overlay) overlayTexture.source = overlay.image;
      return true;
    },
    async getRawOutput() {
      const texture = rayTraceOutputPass.getOutput('color');
      rawReadFrameBuffer.bind(renderer, [texture]);
      const data = new Float32Array(renderWidth * renderHeight * 4);
      renderer.gl.readPixels(
        0,
        0,
        renderWidth,
        renderHeight,
        renderer.gl.RGBA,
        renderer.gl.FLOAT,
        data
      );
      return { data, flipY: true, width: renderWidth, height: renderHeight };
    },
    getDebugBVHData() {
      const debugData = rayTracePass.getDebugBVHData();
      return Promise.resolve(debugData);
    },
    dispose() {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      rayTracePass.dispose();
      rayTraceOutputPass.dispose();
      bloomPass?.dispose();
      composePass.dispose();
      outputPass.dispose();
      overlayTexture.dispose(renderer.gl);
      rawReadFrameBuffer.dispose(renderer);
    }
  } satisfies RenderingPipeline;
}

export default makeWebGLRenderingPipeline;
