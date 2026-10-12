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
export { VERSION } from './version.js';

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
} from './Renderer.js';
export type {
  BVHBuilder,
  DenoiserOptions,
  DenoiserType,
  DepthSampleArea,
  OfflineFrameRenderOptions,
  OfflineFrameRenderResult,
  PrepareSceneOptions,
  PrepareSceneResult,
  RenderStatus,
  RendererDiagnostics,
  RendererInfo,
  RendererParams,
  TextureAtlasLimits
} from './Renderer.js';
export type {
  AlphaBlendStrategy,
  RenderOutput,
  ShaderCompilationDiagnostics,
  ToneMapping
} from './renderer/RenderingPipeline.js';
export type {
  OfflineAdaptiveSamplingOptions,
  OfflineVarianceHistory
} from './renderer/OfflineAdaptiveSampling.js';
export type { OIDNModel } from './oidn.js';
export { DEFAULT_JNLM_OPTIONS } from './renderer/jnlm.js';
export type { JNLMOptions } from './renderer/jnlm.js';

// Scene description
export type {
  AnalyticLight,
  GroundedSkyboxBackground,
  Scene,
  SceneBackground,
  SceneLight
} from './scene/Scene.js';
export { default as Camera } from './scene/Camera.js';
export { default as Mesh } from './scene/Mesh.js';
export { default as SceneNode } from './scene/SceneNode.js';
export {
  default as Geometry,
  Attribute as GeometryAttribute
} from './scene/Geometry.js';
export type { GeometryInit } from './scene/Geometry.js';
export type { OpenPBRMaterialParams } from './scene/OpenPBRMaterial.js';
export { default as OpenPBRMaterial } from './scene/OpenPBRMaterial.js';
export type {
  MaterialAlphaMode,
  UVProjection
} from './scene/OpenPBRMaterial.js';
export { default as Texture } from './scene/Texture.js';
export type { TextureDataSource } from './scene/Texture.js';
export type { ColorRGB, ColorRGBA, Vec2, Vec3, Mat4 } from './types.js';

// Lights
export { default as AmbientLight } from './scene/AmbientLight.js';
export { default as DirectionalLight } from './scene/DirectionalLight.js';
export { default as RectLight } from './scene/RectLight.js';
export { default as SphereLight } from './scene/SphereLight.js';
export { default as SpotLight } from './scene/SpotLight.js';
export { default as EnvironmentLight } from './scene/EnvironmentLight.js';
export {
  default as IESProfile,
  IESParseError,
  parseIESProfile
} from './scene/IESProfile.js';

// Loaders and integrations
export { loadRGBE, parseRGBE } from './util/loadRGBE.js';
export { fromTHREECamera, fromTHREEScene, THREESceneSync } from './util/fromTHREE.js';
export type {
  FromTHREESceneOptions,
  FromTHREECameraOptions
} from './util/fromTHREE.js';
export { default as CameraViewControl } from './util/CameraViewControl.js';

// Geometry helpers
export {
  createCubeGeometry,
  createCurvePlaneGeometry,
  createPlaneGeometry,
  createSphereGeometry
} from './util/commonGeometry.js';
export {
  generateVertexNormals,
  generateVertexTangents
} from './util/geometry.js';
export { computeMeshesBoundingBox } from './util/mesh.js';

// BVH
export type { TinyBvhLayout } from './tinybvh/TinyBvhBuilder.js';

export type { SamplingPattern } from './renderer/sampling.js';
