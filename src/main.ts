/// <reference types="@webgpu/types" preserve="true" />

/**
 * MuTracer: a physically based WebGPU path tracer with a
 * WebGL 2 fallback.
 *
 * Build a {@link Scene} from {@link Mesh}es and lights (or convert a Three.js
 * scene with {@link fromTHREEScene}), then call {@link Renderer.render} once
 * per animation frame.
 *
 * @packageDocumentation
 */
export { VERSION } from './version';

// Renderer
export {
  default as Renderer,
  RENDER_STATUS_UNKNOWN,
  RENDER_STATUS_COMPILING_SHADER,
  RENDER_STATUS_RENDERING,
  RENDER_STATUS_DENOISING,
  RENDER_STATUS_FINISHED,
  RENDER_STATUS_ERROR,
  RENDER_STATUS_PREPARING
} from './Renderer';
export type {
  BVHBuilder,
  DenoiserOptions,
  OfflineFrameRenderOptions,
  OfflineFrameRenderResult,
  RenderStatus,
  RendererDiagnostics,
  RendererParams,
  TextureAtlasLimits
} from './Renderer';
export type {
  AlphaBlendStrategy,
  RenderOutput,
  ShaderCompilationDiagnostics,
  ToneMapping
} from './renderer/RenderingPipeline';
export type {
  OfflineAdaptiveSamplingOptions,
  OfflineVarianceHistory
} from './renderer/OfflineAdaptiveSampling';
export type { OIDNModel } from './oidn';

// Scene description
export type {
  AnalyticLight,
  GroundedSkyboxBackground,
  Scene,
  SceneBackground,
  SceneLight,
  SceneOverlayDataSource
} from './scene/Scene';
export { default as Camera } from './scene/Camera';
export { default as Mesh } from './scene/Mesh';
export { default as SceneNode } from './scene/SceneNode';
export { default as HierarchyNode } from './scene/HierarchyNode';
export {
  default as Geometry,
  Attribute as GeometryAttribute
} from './scene/Geometry';
export { default as OpenPBRMaterial } from './scene/OpenPBRMaterial';
export type {
  DisplacementEdgeProfile,
  DisplacementHeightFilter,
  DisplacementMode,
  DisplacementTessellationMode,
  MaterialAlphaMode,
  UVProjection
} from './scene/OpenPBRMaterial';
export { default as Texture } from './scene/Texture';
export type { TextureDataSource } from './scene/Texture';
export type { ColorRGB, ColorRGBA } from './types';

// Lights
export { default as AmbientLight } from './scene/AmbientLight';
export { default as DirectionalLight } from './scene/DirectionalLight';
export { default as RectLight } from './scene/RectLight';
export { default as SphereLight } from './scene/SphereLight';
export { default as SpotLight } from './scene/SpotLight';
export { default as EnvironmentLight } from './scene/EnvironmentLight';
export {
  default as IESProfile,
  IESParseError,
  parseIESProfile
} from './scene/IESProfile';

// Loaders and integrations
export { load as loadGLTF } from './util/loadGLTF';
export type { GLTFLoadResult } from './util/loadGLTF';
export { loadRGBE, parseRGBE } from './util/loadRGBE';
export { fromTHREECamera, fromTHREEScene, THREESceneSync } from './util/fromTHREE';
export type {
  THREESceneChanges,
  FromTHREESceneOptions
} from './util/fromTHREE';
export { default as CameraViewControl } from './util/CameraViewControl';

// Geometry helpers
export {
  createCubeGeometry,
  createCurvePlaneGeometry,
  createPlaneGeometry,
  createSphereGeometry
} from './util/commonGeometry';
export {
  generateVertexNormals,
  generateVertexTangents
} from './util/geometry';
export { computeMeshesBoundingBox } from './util/mesh';

// Displacement
export { buildOpenSubdivAdaptiveFaceLevels } from './util/tessellateDisplacement';
export type {
  DisplacementTessellationOptions,
  DisplacementTessellationProgress,
  DisplacementTessellationStats
} from './util/tessellateDisplacement';

// BVH and worker precomputation
export { precomputeTinyBvh } from './tinybvh/precomputeTinyBvh';
export type { TinyBvhPrecomputeOptions, TinyBvhPrecomputeStats } from './tinybvh/precomputeTinyBvh';
export type { TinyBvhLayout } from './tinybvh/TinyBvhBuilder';
export {
  prepareForPrecompute,
  precompute,
  resolveFromPrecompute
} from './util/workerHelper';
export type {
  DisplacementGeometryPostprocessor,
  DisplacementTopologyRefiner,
  PrecomputePreparedData,
  PrecomputeProgress,
  PrecomputeResult,
  PrecomputeTimings,
  RefinedDisplacementTopology
} from './util/workerHelper';

export type { SamplingPattern } from './renderer/sampling';
