import { SceneEnvironmentCache, RectLightTextureTracker } from './sceneLightChanges';
import { MaterialChangeTracker, materialIsEmissive, type MaterialUpdateLevel } from './materialChanges';
import {
  constants,
  Renderer as WebGLRenderer,
  Texture2D as WebGLTexture2D,
  TextureImageSource as WebGLTextureImageSource
} from './webgl';
import { WebGLFullQuadPass } from './WebGLFullQuadPass';
import { mat4 } from '../math';
import Mesh from '../scene/Mesh';
import {
  buildBLAS,
  buildTLAS,
  concatBLASBuffers,
  flattenBvh,
  refitBLAS
} from './bvhAccel';
import {
  generateBackgroundMapFromSceneBackground
} from './envMapCreation';
import {
  envMapDistribution,
  environmentMapSourcesMatch,
  type EnvironmentMapSource
} from './envMapDistribution';
import rayTraceFrag from './glsl/rayTrace.frag';
import shadowCatcherFrag from './glsl/shadowCatcher.frag';
import MergedMaterialData, {
  DEFAULT_MAX_TEXTURE_ARRAY_BYTES,
  materialUsesMedium
} from './MergedMaterialData';
import OpenPBRMaterial, {
} from '../scene/OpenPBRMaterial';
import { StratifiedSampler } from './StratifiedSampler';
import { makeStratifiedSamplerCombined } from './StratifiedSamplerCombined';

import DirectionalLight from '../scene/DirectionalLight';
import SphereLight from '../scene/SphereLight';
import RectLight from '../scene/RectLight';
import SpotLight from '../scene/SpotLight';
import { SceneBackground, SceneLight } from '../scene/Scene';
import { isIntelMac, numberArraysEqual } from './util';
import Camera from '../scene/Camera';
import {
  commonLinearFloatProps,
  commonNearestFloatProps,
  setDataTexture,
  textureDimensionsFromArray
} from './dataTextureUtil';
import {
  CONSTANT_DIRECTIONAL_LIGHT,
  CONSTANT_RECT_LIGHT,
  CONSTANT_SPHERE_LIGHT,
  packLightsToBuffer
} from './lightsUtil';
import {
  estimateAnalyticLightPower,
  estimateEnvironmentPower,
  packIESProfiles
} from './lightSampling';
import Geometry, { Attribute } from '../scene/Geometry';
import { updateMeshInstances } from './prepareMeshBVH';
import { mergeMeshesToGeometry } from './mergeMeshesToGeometry';
import {
  DEFAULT_BEVEL_SAMPLES,
  makeBevelSamplingDimensions,
  normalizeBevelSamples
} from './RenderingPipeline';
import {
  getOpenPbrEnergyLutData,
  OPENPBR_ENERGY_LUT_HEIGHT,
  OPENPBR_ENERGY_LUT_WIDTH
} from './openPbrEnergyLut';

type AnalyticLight = DirectionalLight | SphereLight | SpotLight | RectLight;
// A defensive mixture keeps weak-but-wide lights from being starved by an
// imperfect scalar power estimate while still favoring dominant emitters.
const POWER_WEIGHTED_LIGHT_MIX = 0.25;

function packLightsToTexture(
  texture: WebGLTexture2D,
  lights: AnalyticLight[],
  texturesIndices: number[],
  selectionPmfs: ArrayLike<number>,
  selectionCdfs: ArrayLike<number>,
  iesProfileTexelOffsets: ArrayLike<number>
) {
  const data = packLightsToBuffer(
    lights,
    texturesIndices,
    selectionPmfs,
    selectionCdfs,
    iesProfileTexelOffsets
  );
  texture.source = {
    data,
    width: data.length / 4,
    height: 1
  };
}

// TODO EXT_float_blend
// rayTraceBlendNode.inputs = {
//   colorTex: rayTraceNode,
//   prevColorTex: {
//     node: rayTraceBlendNode,
//     prevFrame: true
//   }
// };

// TODO use one method to set all required properties.
// Ensure necessary properties are set.
class WebGLRayTracePass {
  private readonly _renderer: WebGLRenderer;
  private _meshes: Mesh[] = [];
  private _sceneEnvironment = new SceneEnvironmentCache();
  private _rectLightTextures = new RectLightTextureTracker();
  private _analyticLights: AnalyticLight[] = [];
  private _analyticLightSelectionPmfs = new Float32Array(0);
  private _analyticLightSelectionCdfs = new Float32Array(0);
  private _envLightSelectionPmf = 0;
  private _materialData: MergedMaterialData | undefined;
  private _maxTextureArrayBytes = DEFAULT_MAX_TEXTURE_ARRAY_BYTES;
  private _preparedMeshData?: ReturnType<typeof updateMeshInstances>;
  private _materialChanges = new MaterialChangeTracker();
  private _pendingMaterialUpdate?: { level: MaterialUpdateLevel; emission: boolean; materials: Set<OpenPBRMaterial> };
  private _needsUpdateMeshData = true;
  private _meshSnapshot: {
    mesh: Mesh;
    geometry: Mesh['geometry'];
    materials: OpenPBRMaterial[];
    materialVersions: number[];
    geometryVersion: number;
    matrix: number[];
  }[] = [];
  private _needsUpdateAnalyticLightsBuffer = true;
  private _debugBvhData?: {
    buffer: ArrayBuffer;
  };

  private _noiseTex = new WebGLTexture2D({
    wrapS: constants.REPEAT,
    wrapT: constants.REPEAT,
    type: constants.HALF_FLOAT,
    flipY: false,
    useMipmap: false
  });

  private _lightTex = new WebGLTexture2D(commonNearestFloatProps);
  private _iesProfileTex = new WebGLTexture2D(commonNearestFloatProps);
  private _iesProfileColumns = 1;
  private _iesProfileTexelOffsets = new Int32Array(0);
  private _openPbrEnergyLut = new WebGLTexture2D({
    ...commonNearestFloatProps,
    source: {
      data: getOpenPbrEnergyLutData(),
      width: OPENPBR_ENERGY_LUT_WIDTH,
      height: OPENPBR_ENERGY_LUT_HEIGHT
    }
  });

  private _envMap = new WebGLTexture2D(commonLinearFloatProps);
  private _envMapDistribution = new WebGLTexture2D(commonLinearFloatProps);
  private _envImageSource?: EnvironmentMapSource;
  private _backgroundTex = new WebGLTexture2D(commonLinearFloatProps);

  private _hasEnvMap = false;
  private _hasBackground = false;
  private _groundedBackgroundParams = new Float32Array([0, 0, 0, 0]);
  private _groundedBackgroundCenter = new Float32Array([0, 0]);

  private _bounces = 2;
  private _bevelSamples = DEFAULT_BEVEL_SAMPLES;
  private _clamping?: number;

  // how many partitions of stratified noise should be created
  // higher number results in faster convergence over time, but with lower quality initial samples
  private _strataCount = 6;

  private _sampleCount = 0;
  private _samplingDimensions: number[] = [];
  private _samples!: StratifiedSampler;

  private _positionBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _normalBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _colorBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _tangentBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _uvBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _uv1BufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _bvhBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _instancesBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _matIndexBufferTex = new WebGLTexture2D({
    ...commonNearestFloatProps
    // type: constants.INT
  });

  private _hasTransmission = false;
  private _hasAlpha = false;

  private _invalid = false;
  private _transmissiveAlphaMin = 1;

  private _mainPass: WebGLFullQuadPass<
    never,
    'color' | 'albedo' | 'normal'
  >;
  private _shadowCatcherPass: WebGLFullQuadPass<never, 'shadowCatcher'>;

  private _viewProjInv = mat4.create();
  private _aperture = 0;
  private _focusDistance = 10;

  private _tracePasses: WebGLFullQuadPass<any, any>[];
  private _hasShadowCatcher = false;
  private _spectral = false;

  constructor(renderer: WebGLRenderer) {
    this._renderer = renderer;
    const accumulationOutput = {
      type: constants.FLOAT,
      minFilter: constants.LINEAR,
      magFilter: constants.LINEAR,
      wrapS: constants.CLAMP_TO_EDGE,
      wrapT: constants.CLAMP_TO_EDGE
    };

    rayTraceFrag.parallelCompile = true;
    shadowCatcherFrag.parallelCompile = true;
    this._mainPass = new WebGLFullQuadPass<
      never,
      'color' | 'albedo' | 'normal'
    >('rayTrace', renderer, {
      shader: rayTraceFrag,
      outputs: ['color', 'albedo', 'normal'],
      outputParams: {
        color: accumulationOutput,
        albedo: accumulationOutput,
        normal: accumulationOutput
      }
    });
    this._shadowCatcherPass = new WebGLFullQuadPass<never, 'shadowCatcher'>(
      'shadowCatcher',
      renderer,
      {
        shader: shadowCatcherFrag,
        outputs: ['shadowCatcher'],
        outputParams: { shadowCatcher: accumulationOutput }
      }
    );
    this._tracePasses = [this._mainPass, this._shadowCatcherPass];
    this._tracePasses.forEach((pass) => {
      pass.setDefines({
        OES_texture_float_linear: !!renderer.gl.getExtension(
          'OES_texture_float_linear'
        )
      });
      pass.setUniform('noiseTex', this._noiseTex);
    });
    this._mainPass.setUniform('openPbrEnergyLut', this._openPbrEnergyLut);
  }

  createPass(
    clear: boolean,
    tile: { x: number; y: number; width: number; height: number },
    disableShadowCatcher = false
  ) {
    this.prepare();
    const options = {
      clear,
      blend: !clear,
      scissor: tile
    };
    this._mainPass.createPass({} as Record<never, WebGLTexture2D>, undefined, options);
    if (this._hasShadowCatcher && !disableShadowCatcher) {
      this._shadowCatcherPass.createPass(
        {} as Record<never, WebGLTexture2D>,
        undefined,
        options
      );
    }
  }

  getOutput(label: 'color' | 'albedo' | 'normal' | 'shadowCatcher') {
    return label === 'shadowCatcher'
      ? this._shadowCatcherPass.getOutput('shadowCatcher')
      : this._mainPass.getOutput(label);
  }

  setNoise(noiseImage: WebGLTextureImageSource) {
    this._noiseTex.source = noiseImage;
  }

  setBounce(bounce: number) {
    const changed = this._bounces !== bounce;
    this._bounces = bounce;
    if (changed || !this._samplingDimensions.length) {
      this._updateSamplingDimensions();
      this._updateStartifiedSampler();
    }
    return changed;
  }

  setClamping(clamping?: number) {
    const changed = this._clamping !== clamping;
    this._clamping = clamping;
    return changed;
  }

  setBevelSamples(samples: number) {
    const next = normalizeBevelSamples(samples);
    const changed = this._bevelSamples !== next;
    if (changed) {
      this._bevelSamples = next;
      this._updateSamplingDimensions();
      this._updateStartifiedSampler();
    }
    return changed;
  }

  private _setEnvMap(envImage: EnvironmentMapSource | undefined) {
    if (!environmentMapSourcesMatch(envImage, this._envImageSource) && envImage) {
      this._envMap.source = envImage;
      this._envMapDistribution.source = envMapDistribution(envImage);
    }
    this._envImageSource = envImage;
    this._tracePasses.forEach((pass) => {
      pass.setUniform('envMap', envImage ? this._envMap : null);
      pass.setUniform(
        'envMapDistribution',
        envImage ? this._envMapDistribution : null
      );
      pass.setUniform('envLightSelectionPmf', this._envLightSelectionPmf);

      pass.setDefines({
        USE_ENVMAP: !!envImage
      });
    });

    this._hasEnvMap = !!envImage;
  }

  setBackground(background?: SceneBackground) {
    const backgroundImage =
      // TODO
      background && generateBackgroundMapFromSceneBackground(background)!;

    if (backgroundImage) {
      this._backgroundTex.source = backgroundImage;
    }
    this._hasBackground = !!backgroundImage;
    const grounded =
      background &&
      !Array.isArray(background) &&
      'type' in background &&
      background.type === 'GroundedSkybox'
        ? background
        : undefined;
    this._groundedBackgroundParams.set(
      grounded
        ? [
            Math.max(grounded.height, 0.0001),
            Math.max(grounded.radius, 0.0001),
            grounded.groundHeight ?? 0,
            1
          ]
        : [0, 0, 0, 0]
    );
    this._groundedBackgroundCenter.set(grounded?.center ?? [0, 0]);
  }

  setTransmissiveOutputAlphaMin(transmissiveAlphaMin: number) {
    const changed = this._transmissiveAlphaMin !== transmissiveAlphaMin;
    this._transmissiveAlphaMin = transmissiveAlphaMin;
    return changed;
  }

  setMeshes(meshes: Mesh[], update?: { transforms?: readonly Mesh[]; materials?: readonly OpenPBRMaterial[] }) {
    if (update && !update.transforms?.length && this._preparedMeshData && this._materialData &&
      !this._needsUpdateMeshData && meshes === this._meshes) {
      const change = this._materialChanges.classify(update.materials ?? []);
      if (change.level !== 'geometry') {
        if (update.materials?.length) {
          const pending = this._pendingMaterialUpdate;
          this._pendingMaterialUpdate = { level: pending?.level === 'textures' ? 'textures' : change.level,
            emission: !!pending?.emission || change.emission,
            materials: new Set([...(pending?.materials ?? []), ...update.materials]) };
          this._meshSnapshot.forEach(item => { item.materialVersions = item.materials.map(m => m.version); });
        }
        return !!update.materials?.length;
      }
    }
    const materialChange = !!update?.materials?.length;
    const next = meshes.map((mesh) => ({
      mesh,
      geometry: mesh.geometry,
      materials: mesh.materials.slice(),
      materialVersions: mesh.materials.map(material => material.version),
      geometryVersion: mesh.geometry.version,
      matrix: Array.from(mesh.matrixWorld as ArrayLike<number>)
    }));
    const changed =
      next.length !== this._meshSnapshot.length ||
      next.some((item, i) => {
        const prev = this._meshSnapshot[i];
        return (
          !prev ||
          item.mesh !== prev.mesh ||
          item.geometry !== prev.geometry ||
          item.materials.length !== prev.materials.length ||
          item.materials.some((material, k) => material !== prev.materials[k]) ||
          item.materialVersions.some((hash, k) => hash !== prev.materialVersions[k]) ||
          item.geometryVersion !== prev.geometryVersion ||
          item.matrix.some((value, k) => value !== prev.matrix[k])
        );
      });
    next.forEach((item, i) => {
      const prev = this._meshSnapshot[i];
      if (
        prev &&
        item.geometry === prev.geometry &&
        item.geometryVersion !== prev.geometryVersion
      ) {
        const usesDisplacement =
          !!item.materials[0]?.displacementMap &&
          Math.abs(item.materials[0].displacementScale) > 1e-6;
        if (
          usesDisplacement ||
          !item.geometry.bvh ||
          !refitBLAS(item.geometry.bvh, item.geometry)
        ) {
          item.geometry.bvh = undefined;
        }
      }
    });
    this._meshSnapshot = next;
    if (!changed && update && !materialChange) return false;
    this._meshes = meshes;
    this._needsUpdateMeshData = true;
    this._debugBvhData = undefined;
    return true;
  }

  setTextureAtlasBudget(maxBytes: number) {
    const next = Number.isFinite(maxBytes)
      ? Math.max(4, Math.floor(maxBytes))
      : DEFAULT_MAX_TEXTURE_ARRAY_BYTES;
    if (next === this._maxTextureArrayBytes) return false;
    this._maxTextureArrayBytes = next;
    this._needsUpdateMeshData = true;
    return true;
  }

  getDebugBVHData() {
    if (!this._debugBvhData) {
      const mergedMesh = mergeMeshesToGeometry(this._meshes);
      const bvh = flattenBvh(buildBLAS(mergedMesh.geometry, 0, undefined), false);
      this._debugBvhData = { buffer: bvh.buffer };
    }
    return this._debugBvhData;
  }

  getDiagnostics() {
    return {
      textureAtlas: this._materialData?.textureAtlasStats
    };
  }

  private _updateMeshData() {
    this._needsUpdateMeshData = false;

    const res = updateMeshInstances(this._meshes);
    this._preparedMeshData = res;
    const mergedGeometry = res.geometry;
    const materials = res.materials;
    const tlas = flattenBvh(buildTLAS(res.instances, res.blases), true);
    const tlasBuffer = new Float32Array(tlas.buffer);
    const instancesBuffer = new Float32Array(tlas.instancesBuffer!);
    const blasBuffer = new Float32Array(concatBLASBuffers(res.blases));
    const bvhBuffer = new Float32Array(tlasBuffer.length + blasBuffer.length);
    const blasOffset = tlasBuffer.length / 4;
    bvhBuffer.set(tlasBuffer);
    bvhBuffer.set(blasBuffer, blasOffset * 4);

    if (mergedGeometry.position.array.length > 0) {
      setDataTexture(this._positionBufferTex, mergedGeometry.position.array, 3);
      setDataTexture(this._normalBufferTex, mergedGeometry.normal.array, 3);
      mergedGeometry.color &&
        setDataTexture(this._colorBufferTex, mergedGeometry.color.array, 3);
      mergedGeometry.tangent &&
        setDataTexture(this._tangentBufferTex, mergedGeometry.tangent.array, 3);
      mergedGeometry.uv &&
        setDataTexture(this._uvBufferTex, mergedGeometry.uv.array, 2);
      mergedGeometry.uv1 &&
        setDataTexture(this._uv1BufferTex, mergedGeometry.uv1.array, 2);
      mergedGeometry.materialIndex &&
        setDataTexture(
          this._matIndexBufferTex,
          // TODO currently int texture doesn't work
          new Float32Array(mergedGeometry.materialIndex.array),
          4
        );
    }
    if (bvhBuffer.length > 0) {
      setDataTexture(this._bvhBufferTex, bvhBuffer, 4);
      setDataTexture(this._instancesBufferTex, instancesBuffer, 4);
    }

    this._materialData?.dispose(this._renderer.gl);
    const materialData = new MergedMaterialData(
      materials,
      this._analyticLights,
      {
        maxTextureArrayBytes: this._maxTextureArrayBytes,
        maxTextureArrayLayers: this._renderer.gl.getParameter(
          this._renderer.gl.MAX_ARRAY_TEXTURE_LAYERS
        ),
        maxTextureDimension2D: this._renderer.gl.getParameter(
          this._renderer.gl.MAX_TEXTURE_SIZE
        )
      }
    );
    this._materialData = materialData;

    this._tracePasses.forEach((pass) => {
      pass.setUniforms({
        bvhBuffer: this._bvhBufferTex,
        instancesBuffer: this._instancesBufferTex,
        positionBuffer: this._positionBufferTex,
        normalBuffer: this._normalBufferTex,
        tangentBuffer: mergedGeometry.tangent ? this._tangentBufferTex : null,
        colorBuffer: mergedGeometry.color ? this._colorBufferTex : null,
        uvBuffer: mergedGeometry.uv ? this._uvBufferTex : null,
        uv1Buffer: mergedGeometry.uv1 ? this._uv1BufferTex : null,
        materialIndexBuffer: this._matIndexBufferTex,

        bvhColumns: textureDimensionsFromArray(bvhBuffer.length / 4).columnsLog,
        vertexColumns: textureDimensionsFromArray(
          Attribute.getCount(mergedGeometry.position)
        ).columnsLog,
        instancesColumns: textureDimensionsFromArray(instancesBuffer.length / 4)
          .columnsLog,
        blasOffset,

        isEmptyScene: +(res.instances.length === 0)
      });

    });
    this._updateMaterialConstants(materials, materialData, mergedGeometry);
    this._materialChanges.capture(materials);
    this._pendingMaterialUpdate = undefined;

    return bvhBuffer;
  }

  private _updateMaterialConstants(materials: OpenPBRMaterial[], materialData: MergedMaterialData, mergedGeometry: Geometry) {
    // Avoid too much shader compilation
    const STACK_SIZE = 50;
    const hasShadowCatcher = materials.some((m) => m.shadowCatcher);
    const HAS_BEVEL = materials.some((m) => m.bevelSize > 0);
    const HAS_MEDIUM = materials.some(materialUsesMedium);

    this._hasShadowCatcher = hasShadowCatcher;
    this._hasTransmission = materials.some(
      (m) =>
        m.transmissionWeight > 0 ||
        m.mapAlphaUsage === OpenPBRMaterial.mapAlphaUsageTransmission
    );
    this._hasAlpha = materials.some(
      (m) =>
        m.opacity < 1 || +m.mapAlphaUsage === OpenPBRMaterial.mapAlphaUsageAlpha
    );
    this._spectral = materials.some((m) => m.transmissionDispersionScale > 0);

    // this._invalid = mergedGeometry.position.array.length === 0;

    this._tracePasses.forEach(pass => {
      pass.setDefines({
        // TODO
        OES_texture_float_linear: true,

        STACK_SIZE,
        USE_VERTEX_COLOR: mergedGeometry.color != null,
        USE_TANGENT: mergedGeometry.tangent != null,
        HAS_TRANSMISSION: this._hasTransmission,
        HAS_BEVEL,
        HAS_MEDIUM,
        HAS_ALPHA: this._hasAlpha,

        BEVEL_SAMPLES: this._bevelSamples,
        SAMPLING_DIMENSIONS: this._samplingDimensions.reduce((a, b) => a + b),

        RECT_LIGHT: CONSTANT_RECT_LIGHT,
        SPHERE_LIGHT: CONSTANT_SPHERE_LIGHT,
        DIRECTIONAL_LIGHT: CONSTANT_DIRECTIONAL_LIGHT,

        USE_RR: true,
        // Multiple-scattering SSS paths need enough collisions to return to
        // the boundary before roulette; terminating at depth five produces
        // dark materials and a handful of very large surviving samples.
        RR_MAX: HAS_MEDIUM ? 12 : 2,

        ...materialData.defines
      });

      materialData.setToPass(pass);
    });
  }

  private _updateMaterialData() {
    const update = this._pendingMaterialUpdate!;
    const res = this._preparedMeshData!;
    let data = this._materialData!;
    if (update.level === 'textures') {
      data.dispose(this._renderer.gl);
      data = this._materialData = new MergedMaterialData(res.materials, this._analyticLights, {
        maxTextureArrayBytes: this._maxTextureArrayBytes,
        maxTextureArrayLayers: this._renderer.gl.getParameter(this._renderer.gl.MAX_ARRAY_TEXTURE_LAYERS),
        maxTextureDimension2D: this._renderer.gl.getParameter(this._renderer.gl.MAX_TEXTURE_SIZE)
      });
      this._needsUpdateAnalyticLightsBuffer = true;
    } else data.repackParams(res.materials);
    this._updateMaterialConstants(res.materials, data, res.geometry);
    if (update.emission || update.level === 'textures') {
      // WebGL currently evaluates mesh emission on path hits; its direct-light
      // sampler has only analytic/environment sources. Retain that behavior.
      res.emissiveBindings = res.instanceBindings.filter(binding =>
        binding.materialIndices.some(index => materialIsEmissive(res.materials[index])));
    }
    this._materialChanges.capture([...update.materials]);
    this._pendingMaterialUpdate = undefined;
  }

  setLights(lights: SceneLight[]) {
    const analyticLights = lights.filter(
      (light) =>
        light.type === 'DirectionalLight' ||
        light.type === 'SphereLight' ||
        light.type === 'SpotLight' ||
        light.type === 'RectLight'
    ) as AnalyticLight[];
    const numAnalyticLights = analyticLights.length;

    const envImage = this._sceneEnvironment.update(lights);

    const envWeight = estimateEnvironmentPower(envImage);
    const analyticWeights = analyticLights.map(estimateAnalyticLightPower);
    const totalWeight =
      envWeight + analyticWeights.reduce((sum, weight) => sum + weight, 0);
    const sourceCount = analyticLights.length + (envImage ? 1 : 0);
    const fallbackPmf = sourceCount > 0 ? 1 / sourceCount : 0;
    this._envLightSelectionPmf = envImage
      ? totalWeight > 0
        ? (1 - POWER_WEIGHTED_LIGHT_MIX) * fallbackPmf +
          POWER_WEIGHTED_LIGHT_MIX * (envWeight / totalWeight)
        : fallbackPmf
      : 0;
    this._analyticLightSelectionPmfs = Float32Array.from(
      analyticWeights,
      (weight) =>
        totalWeight > 0
          ? (1 - POWER_WEIGHTED_LIGHT_MIX) * fallbackPmf +
            POWER_WEIGHTED_LIGHT_MIX * (weight / totalWeight)
          : fallbackPmf
    );
    let cumulativePmf = this._envLightSelectionPmf;
    this._analyticLightSelectionCdfs = Float32Array.from(
      this._analyticLightSelectionPmfs,
      (pmf) => {
        cumulativePmf += pmf;
        return cumulativePmf;
      }
    );
    if (this._analyticLightSelectionCdfs.length > 0) {
      this._analyticLightSelectionCdfs[
        this._analyticLightSelectionCdfs.length - 1
      ] = 1;
    }

    this._tracePasses.forEach((pass) => {
      pass.setDefines({
        NUM_LIGHTS: numAnalyticLights,
        HAS_SPHERE_LIGHTS: !!analyticLights.find(
          (light) => light.type === 'SphereLight'
        ),
        HAS_SPOT_LIGHTS: !!analyticLights.find(
          (light) => light.type === 'SpotLight'
        ),
        HAS_RECT_LIGHTS: !!analyticLights.find(
          (light) => light.type === 'RectLight'
        ),
        HAS_DIRECTIONAL_LIGHTS: !!analyticLights.find(
          (light) => light.type === 'DirectionalLight'
        )
      });
    });

    const lightTexturesChanged = this._rectLightTextures.update(analyticLights);
    this._analyticLights = analyticLights;
    const packedIES = packIESProfiles(analyticLights);
    this._iesProfileTexelOffsets = packedIES.offsets;
    this._iesProfileColumns = setDataTexture(
      this._iesProfileTex,
      packedIES.data.length ? packedIES.data : new Float32Array(4),
      4
    ).columns;
    if (lightTexturesChanged) this._needsUpdateMeshData = true;

    this._needsUpdateAnalyticLightsBuffer = true;

    this._setEnvMap(envImage);
  }

  private _getViewProjInv(camera: Camera, viewProjInv: mat4.Mat4Array) {
    mat4.invert(viewProjInv, Camera.getProjectionMatrix(camera));
    mat4.mul(viewProjInv, camera.matrixWorld, viewProjInv);
  }

  setCamera(camera: Camera) {
    const viewProjectionInv = this._viewProjInv;
    this._aperture = camera.aperture;
    this._focusDistance = camera.focusDistance;
    this._getViewProjInv(camera, viewProjectionInv);
    const isOrtho = camera.projection === 'orthographic';
    this._tracePasses.forEach((pass) => {
      pass.setUniform('viewProjectionInv', viewProjectionInv);
      pass.setUniform('viewInv', camera.matrixWorld);
      // Not support depth of field in orthographic camera
      pass.setUniform('cameraAperture', isOrtho ? 0 : camera.aperture);
      pass.setUniform('cameraFocus', camera.focusDistance);
    });
  }

  cameraChanged(camera: Camera) {
    const tmp = mat4.create();
    this._getViewProjInv(camera, tmp);
    return (
      !numberArraysEqual(this._viewProjInv, tmp) ||
      camera.aperture !== this._aperture ||
      camera.focusDistance !== this._focusDistance
    );
  }

  // TODO in prepare.
  setSize(width: number, height: number) {
    this._tracePasses.forEach((pass) => {
      pass.setSize(width, height);
      pass.setUniform('pixelSize', [1 / width, 1 / height]);
    });
  }

  setJitter(x: number, y: number) {
    this._tracePasses.forEach((pass) => {
      pass.setUniform('jitter', [x, y]);
    });
  }

  setPreviewMode(enabled: boolean, bounces: number) {
    this._tracePasses.forEach((pass) => {
      pass.setUniform('previewMode', enabled);
      pass.setUniform('previewBounces', Math.max(1, Math.round(bounces)));
    });
  }

  setWavelength(wavelength: number) {
    this._tracePasses.forEach((pass) => {
      pass.setUniform('wavelength', wavelength);
    });
  }

  setSampleCount(sampleCount: number) {
    if (sampleCount !== this._sampleCount) {
      const restartSequence =
        sampleCount === 0 || sampleCount < this._sampleCount;
      this._sampleCount = sampleCount;
      if (restartSequence || !this._samples) {
        this._updateStartifiedSampler();
      } else {
        // The first four samples use a full-domain warm-up for a useful early
        // preview. Start the actual stratified sequence from its first cell.
        if (sampleCount === 4) this._samples.restart();
        this._nextStratifiedSample();
      }
    }
    this._tracePasses.forEach((pass) => {
      pass.setUniform('sampleCount', sampleCount);
    });
  }

  isInvalid() {
    return this._invalid;
  }

  hasShadowCatcher() {
    return this._hasShadowCatcher;
  }

  hasDispersion() {
    return this._spectral;
  }

  private _updateSamplingDimensions() {
    this._samplingDimensions = makeBevelSamplingDimensions(
      this._bevelSamples
    );
    for (let i = 1; i <= this._bounces; i++) {
      // specular or diffuse reflection, light importance sampling, next path direction
      // TODO fix
      this._samplingDimensions.push(2, 2, 2);
      if (i >= 2) {
        // russian roulette sampling
        // this step is skipped on the first bounce
        this._samplingDimensions.push(1);
      }
    }
  }

  private _updateStartifiedSampler() {
    this._samples = makeStratifiedSamplerCombined(
      this._strataCount,
      this._samplingDimensions,
      0
    );
    this._nextStratifiedSample();
  }

  private _nextStratifiedSample() {
    const nextSamples = this._samples.next();

    this._tracePasses.forEach((pass) => {
      pass.setUniform('stratifiedSamples', nextSamples);
      pass.setUniform(
        'strataSize',
        // Use a full-domain warm-up before beginning the N-way strata cycle.
        this._sampleCount < 4 ? 1.0 : 1.0 / this._strataCount
      );
    });
  }

  prepare(): void {
    if (this._needsUpdateMeshData) {
      this._updateMeshData();
    }

    if (this._pendingMaterialUpdate) this._updateMaterialData();

    if (this._needsUpdateAnalyticLightsBuffer) {
      const analyticLights = this._analyticLights;
      analyticLights.length > 0 &&
        packLightsToTexture(
          this._lightTex,
          analyticLights,
          this._materialData!.getLightTexturesIndices(),
          this._analyticLightSelectionPmfs,
          this._analyticLightSelectionCdfs,
          this._iesProfileTexelOffsets
        );
      this._needsUpdateAnalyticLightsBuffer = false;
    }

    this._tracePasses.forEach((pass) => {
      pass.setUniform(
        'backgroundMap',
        this._hasBackground
          ? this._backgroundTex
          : this._hasEnvMap
            ? this._envMap
            : null
      );

      pass.setUniform(
        'transmissiveOutputAlphaMin',
        Math.max(Math.min(1, this._transmissiveAlphaMin), 0)
      );

      pass.setUniform('lightsTex', this._lightTex);
      pass.setUniform('iesProfileData', this._iesProfileTex);
      pass.setUniform('iesProfileColumns', this._iesProfileColumns);
      pass.setUniform('groundedBackgroundParams', this._groundedBackgroundParams);
      pass.setUniform('groundedBackgroundCenter', this._groundedBackgroundCenter);

      pass.setDefines({
        // Double bounce fix on intel mac
        // Limit the bounce to avoid long compilation time.
        BOUNCES: isIntelMac
          ? Math.min(this._bounces, 3) *
            (this._hasTransmission || this._hasAlpha ? 2 : 1)
          : this._bounces,
        CLAMPING: this._clamping || undefined,
        BEVEL_SAMPLES: this._bevelSamples,
        SAMPLING_DIMENSIONS: this._samplingDimensions.reduce(
          (sum, dimensions) => sum + dimensions,
          0
        ),
        USE_BACKGROUND: this._hasBackground,
        USE_GROUNDED_BACKGROUND: this._groundedBackgroundParams[3] > 0
      });
    });
  }

  setStratifiedSampling(enabled: boolean) {
    return this._tracePasses.reduce(
      (changed, pass) =>
        pass.setDefines({ USE_STRATIFIED_SAMPLING: enabled }) || changed,
      false
    );
  }

  dispose() {
    this._materialData?.dispose(this._renderer.gl);
    this._materialData = undefined;
    this._tracePasses.forEach((pass) => pass.dispose());
    const gl = this._renderer.gl;
    [
      this._noiseTex,
      this._lightTex,
      this._openPbrEnergyLut,
      this._envMap,
      this._envMapDistribution,
      this._backgroundTex,
      this._positionBufferTex,
      this._normalBufferTex,
      this._colorBufferTex,
      this._tangentBufferTex,
      this._uvBufferTex,
      this._uv1BufferTex,
      this._bvhBufferTex,
      this._instancesBufferTex,
      this._matIndexBufferTex
    ].forEach((texture) => texture.dispose(gl));
  }
}

export default WebGLRayTracePass;
