import type * as THREE from 'three';
import Mesh from '../scene/Mesh';
import OpenPBRMaterial from '../scene/OpenPBRMaterial';
import Geometry, { Attribute } from '../scene/Geometry';
import Texture from '../scene/Texture';
import DirectionalLight from '../scene/DirectionalLight';
import AmbientLight from '../scene/AmbientLight';
import EnvironmentLight from '../scene/EnvironmentLight';
import RectLight from '../scene/RectLight';
import SphereLight from '../scene/SphereLight';
import SpotLight from '../scene/SpotLight';
import IESProfile from '../scene/IESProfile';
import Camera from '../scene/Camera';
import { ColorRGB, ColorRGBA } from '../types';
import { GroundedSkyboxBackground, SceneLight } from '../scene/Scene';
import { mat4 } from '../math';
import { generateVertexNormals, updateBoundingBox } from './geometry';

const environmentLightCache = new WeakMap<
  THREE.DataTexture,
  EnvironmentLight
>();

function convertTexture(
  threeTexture: THREE.Texture | null | undefined,
  textureCache: WeakMap<THREE.Texture, Texture>
) {
  if (!threeTexture) {
    return;
  }
  const cachedTexture = textureCache.get(threeTexture);
  if (cachedTexture) {
    return cachedTexture;
  }
  const texture = new Texture(threeTexture.image as Texture['image']);
  texture.source = threeTexture;
  texture.version = threeTexture.version;
  texture.flipY = threeTexture.flipY;
  texture.uvScale = [threeTexture.repeat.x, threeTexture.repeat.y];
  texture.uvOffset = [threeTexture.offset.x, threeTexture.offset.y];
  texture.uvChannel =
    (threeTexture as THREE.Texture & { channel?: number }).channel === 1
      ? 1
      : 0;
  textureCache.set(threeTexture, texture);
  return texture;
}

function halfFloatToFloat(value: number) {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0) {
    return sign * Math.pow(2, -14) * (fraction / 0x400);
  }
  if (exponent === 0x1f) {
    return fraction ? NaN : sign * Infinity;
  }
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 0x400);
}

function convertDataTexture(threeTexture?: THREE.DataTexture | null) {
  if (!threeTexture) return;
  const image = threeTexture?.image;
  if (!image?.data || !image.width || !image.height) return;

  const source = image.data as ArrayBufferView;
  let data: Float32Array | Uint8Array | Int32Array;
  if (source instanceof Uint16Array) {
    data = Float32Array.from(source, halfFloatToFloat);
  } else if (
    source instanceof Float32Array ||
    source instanceof Uint8Array ||
    source instanceof Int32Array
  ) {
    data = source;
  } else {
    data = Float32Array.from(source as unknown as ArrayLike<number>);
  }

  const texture = new Texture({
    data,
    width: image.width,
    height: image.height
  });
  texture.source = threeTexture;
  texture.version = threeTexture.version;
  return texture;
}

function convertEnvironmentLight(threeTexture: THREE.DataTexture) {
  const cached = environmentLightCache.get(threeTexture);
  if (cached?.map.version === threeTexture.version) return cached;
  const map = convertDataTexture(threeTexture);
  if (!map) return;
  if (cached) {
    cached.map = map;
    return cached;
  }
  const light = new EnvironmentLight(map);
  environmentLightCache.set(threeTexture, light);
  return light;
}

function convertMaterial(
  threeMaterial: THREE.Material,
  textureCache: WeakMap<THREE.Texture, Texture>
) {
  const material = new OpenPBRMaterial();
  if (threeMaterial.userData.clayptShadowCatcher === true) {
    material.shadowCatcher = true;
    return material;
  }
  if ((threeMaterial as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    const basic = threeMaterial as THREE.MeshBasicMaterial;
    // GLTFLoader represents KHR_materials_unlit as MeshBasicMaterial. Keep its
    // base-color texture's alpha while displaying RGB without scene lighting.
    material.unlit = true;
    material.baseWeight = 0;
    material.specularWeight = 0;
    material.baseColor = basic.color.toArray() as ColorRGB;
    material.emissionColor = material.baseColor;
    material.emissionLuminance = 1;
    material.map = convertTexture(basic.map, textureCache);
    material.emissiveMap = material.map;
    material.alphaMap = convertTexture(basic.alphaMap, textureCache);
    material.opacity = basic.opacity;
    material.alphaCutoff = Math.max(0, basic.alphaTest);
    material.alphaMode = basic.alphaTest > 0
      ? 'mask'
      : basic.transparent || basic.opacity < 1 || !!basic.alphaMap
        ? 'blend'
        : 'opaque';
    material.mapAlphaUsage = material.alphaMode === 'opaque'
      ? OpenPBRMaterial.mapAlphaUsageOpaque
      : OpenPBRMaterial.mapAlphaUsageAlpha;
    material.doubleSided = basic.side === 2;
    return material;
  }
  const standardMaterial = threeMaterial as THREE.MeshStandardMaterial;
  material.baseColor = standardMaterial.color.toArray() as ColorRGB;
  material.emissionColor =
    standardMaterial.emissive &&
    (standardMaterial.emissive.toArray() as ColorRGB);
  material.specularRoughness = standardMaterial.roughness;
  material.baseMetalness = standardMaterial.metalness;
  material.emissionLuminance = standardMaterial.emissiveIntensity;

  material.normalScale =
    standardMaterial.normalScale && standardMaterial.normalScale.toArray();

  const materialUvProjection = standardMaterial.userData
    .clayptUvProjection;
  if (
    materialUvProjection === 'triplanar' ||
    materialUvProjection === 'spherical' ||
    materialUvProjection === 'cylindrical' ||
    materialUvProjection === 'none'
  ) {
    material.uvProjection = materialUvProjection;
  }
  const materialUvScale = standardMaterial.userData.clayptUvScale;
  if (Array.isArray(materialUvScale) && materialUvScale.length >= 2) {
    const referenceLength = Math.max(
      Number(standardMaterial.userData.clayptUvReferenceLength) || 1,
      0.000001
    );
    const scaleX = Math.max(
      Number(materialUvScale[0]) || 0.000001,
      0.000001
    );
    const scaleY = Math.max(
      Number(materialUvScale[1]) || 0.000001,
      0.000001
    );
    material.uvScale = material.uvProjection === 'triplanar'
      ? [scaleX / referenceLength, scaleY / referenceLength]
      : material.uvProjection === 'cylindrical'
        ? [scaleX, scaleY / referenceLength]
        : [scaleX, scaleY];
  }

  material.map = convertTexture(standardMaterial.map, textureCache);
  material.alphaMap = convertTexture(standardMaterial.alphaMap, textureCache);
  material.alphaCutoff = Math.max(
    0,
    Number.isFinite(standardMaterial.alphaTest) ? standardMaterial.alphaTest : 0
  );
  material.emissiveMap = convertTexture(
    standardMaterial.emissiveMap,
    textureCache
  );
  material.normalMap = convertTexture(standardMaterial.normalMap, textureCache);
  material.displacementMap = convertTexture(
    standardMaterial.displacementMap,
    textureCache
  );
  const displacementScale = Number(standardMaterial.displacementScale);
  material.displacementScale = Number.isFinite(displacementScale)
    ? displacementScale
    : material.displacementScale;
  const displacementBias = Number(standardMaterial.displacementBias);
  material.displacementBias = Number.isFinite(displacementBias)
    ? displacementBias
    : 0;
  const displacementStepSize = Number(
    standardMaterial.userData.clayptDisplacementStepSize
  );
  if (Number.isFinite(displacementStepSize)) {
    material.displacementStepSize = Math.max(0.000001, displacementStepSize);
  }
  const displacementMode = standardMaterial.userData
    .clayptDisplacementMode;
  material.displacementMode = displacementMode === 'tessellated'
    ? 'tessellated'
    : 'projective';
  const tessellationMode = standardMaterial.userData
    .clayptDisplacementTessellationMode;
  material.displacementTessellationMode = tessellationMode === 'opensubdiv-adaptive'
    ? 'opensubdiv'
    : [
        'uniform',
        'adaptive',
        'opensubdiv'
      ].includes(tessellationMode)
      ? tessellationMode
      : 'adaptive';
  const uvProjection = standardMaterial.userData
    .clayptDisplacementUvProjection;
  if (
    uvProjection === 'triplanar' ||
    uvProjection === 'spherical' ||
    uvProjection === 'cylindrical' ||
    uvProjection === 'none'
  ) {
    material.displacementUvProjection = uvProjection;
  }
  const displacementUvScale = Number(
    standardMaterial.userData.clayptDisplacementUvScale
  );
  if (Number.isFinite(displacementUvScale)) {
    material.displacementUvScale = Math.max(displacementUvScale, 0.000001);
  }
  const resolvedMaxSubdivisionLevel = Number(
    standardMaterial.userData
      .clayptDisplacementResolvedMaxSubdivisionLevel
  );
  const maxSubdivisionLevel = Number.isFinite(resolvedMaxSubdivisionLevel)
    ? resolvedMaxSubdivisionLevel
    : Number(
        standardMaterial.userData.clayptDisplacementMaxSubdivisionLevel
      );
  if (Number.isFinite(maxSubdivisionLevel)) {
    material.displacementMaxSubdivisionLevel = Math.min(
      8,
      Math.max(0, Math.floor(maxSubdivisionLevel))
    );
  }
  const resolvedMinSubdivisionLevel = Number(
    standardMaterial.userData
      .clayptDisplacementResolvedMinSubdivisionLevel
  );
  if (Number.isFinite(resolvedMinSubdivisionLevel)) {
    material.displacementMinSubdivisionLevel = Math.min(
      material.displacementMaxSubdivisionLevel,
      Math.max(0, Math.floor(resolvedMinSubdivisionLevel))
    );
  }
  const maxError = Number(
    standardMaterial.userData.clayptDisplacementMaxError
  );
  if (Number.isFinite(maxError)) {
    material.displacementMaxError = Math.max(0, maxError);
  }
  const maxTriangles = Number(
    standardMaterial.userData.clayptDisplacementMaxTriangles
  );
  if (Number.isFinite(maxTriangles)) {
    material.displacementMaxTriangles = Math.min(
      8_000_000,
      Math.max(1, Math.floor(maxTriangles))
    );
  }
  const edgeProfile = standardMaterial.userData
    .clayptDisplacementEdgeProfile;
  if (
    edgeProfile === 'smooth' ||
    edgeProfile === 'beveled' ||
    edgeProfile === 'hard' ||
    edgeProfile === 'auto'
  ) {
    material.displacementEdgeProfile = edgeProfile;
  }
  const threshold = Number(
    standardMaterial.userData.clayptDisplacementThreshold
  );
  if (Number.isFinite(threshold)) {
    material.displacementThreshold = Math.min(Math.max(threshold, 0), 1);
  }
  const edgeWidth = Number(
    standardMaterial.userData.clayptDisplacementEdgeWidth
  );
  if (Number.isFinite(edgeWidth)) {
    material.displacementEdgeWidth = Math.max(edgeWidth, 0.01);
  }
  const hardContourGeometry = standardMaterial.userData
    .clayptDisplacementHardContourGeometry;
  if (typeof hardContourGeometry === 'boolean') {
    material.displacementHardContourGeometry = hardContourGeometry;
  }
  const contourSmoothing = Number(
    standardMaterial.userData.clayptDisplacementContourSmoothing
  );
  if (Number.isFinite(contourSmoothing)) {
    material.displacementContourSmoothing = Math.min(
      Math.max(Math.floor(contourSmoothing), 0),
      8
    );
  }
  const contourSubdivisionLevel = Number(
    standardMaterial.userData.clayptDisplacementContourSubdivisionLevel
  );
  if (Number.isFinite(contourSubdivisionLevel)) {
    material.displacementContourSubdivisionLevel = Math.min(
      Math.max(Math.floor(contourSubdivisionLevel), 0),
      3
    );
  }
  const creaseAngle = Number(
    standardMaterial.userData.clayptDisplacementCreaseAngle
  );
  if (Number.isFinite(creaseAngle)) {
    material.displacementCreaseAngle = Math.min(
      Math.max(creaseAngle, 0),
      180
    );
  }
  const heightFilter = standardMaterial.userData
    .clayptDisplacementHeightFilter;
  if (heightFilter === 'linear' || heightFilter === 'nearest') {
    material.displacementHeightFilter = heightFilter;
  }
  material.displacementHeightPrefilter =
    standardMaterial.userData.clayptDisplacementHeightPrefilter === true;
  const bumpStrength = Number(
    standardMaterial.userData.clayptDisplacementBumpStrength
  );
  if (Number.isFinite(bumpStrength)) {
    material.displacementBumpStrength = Math.max(0, bumpStrength);
  }
  if (
    standardMaterial.roughnessMap &&
    standardMaterial.roughnessMap === standardMaterial.metalnessMap
  ) {
    material.metallicRoughnessMap = convertTexture(
      standardMaterial.roughnessMap,
      textureCache
    );
  } else {
    material.roughnessMap = convertTexture(
      standardMaterial.roughnessMap,
      textureCache
    );
    material.metalnessMap = convertTexture(
      standardMaterial.metalnessMap,
      textureCache
    );
  }
  const physicalMaterial = standardMaterial as THREE.MeshPhysicalMaterial;
  if (physicalMaterial.type === 'MeshPhysicalMaterial') {
    material.transmissionWeight = physicalMaterial.transmission;
    material.transmissionMap = convertTexture(
      physicalMaterial.transmissionMap,
      textureCache
    );
    material.specularIor = physicalMaterial.ior;
    material.specularWeight = physicalMaterial.specularIntensity;
    if (physicalMaterial.specularColor) {
      material.specularColor =
        physicalMaterial.specularColor.toArray() as ColorRGB;
    }
    material.coatWeight = physicalMaterial.clearcoat;
    material.coatRoughness = physicalMaterial.clearcoatRoughness;
    // MeshPhysicalMaterial's clearcoat BRDF uses the fixed dielectric F0
    // for IOR 1.5. Match that in the OpenPBR path representation; explicit
    // clayptOpenPBR metadata below may provide a different coat IOR.
    material.coatIor = 1.5;
    material.fuzzWeight = physicalMaterial.sheen;
    if (physicalMaterial.sheenColor) {
      material.fuzzColor = physicalMaterial.sheenColor.toArray() as ColorRGB;
    }
    if (physicalMaterial.attenuationColor) {
      material.transmissionColor =
        physicalMaterial.attenuationColor.toArray() as ColorRGB;
    }
    if (Number.isFinite(physicalMaterial.attenuationDistance)) {
      material.transmissionDepth = Math.max(
        0,
        physicalMaterial.attenuationDistance
      );
    }
  }
  const dispersion = Number(physicalMaterial.dispersion);
  material.transmissionDispersionScale = Number.isFinite(dispersion)
    ? Math.min(1, Math.max(0, dispersion))
    : 0;
  const realtimeIridescence = physicalMaterial as THREE.MeshPhysicalMaterial & {
    iridescence?: number;
    iridescenceIOR?: number;
    iridescenceThicknessRange?: number[];
    iridescenceThicknessMap?: THREE.Texture | null;
  };
  material.thinFilmThickness = Math.min(
    20,
    Math.max(
      0,
      (realtimeIridescence.iridescenceThicknessRange?.[1] ?? 500) / 1000
    )
  );
  material.thinFilmWeight = Math.min(
    1, Math.max(0, realtimeIridescence.iridescence ?? 0)
  );
  material.thinFilmIor = Math.min(
    2.5, Math.max(1, realtimeIridescence.iridescenceIOR ?? 1.4)
  );
  const thinFilmMap =
    (standardMaterial.userData
      .clayptThinFilmMap as THREE.Texture | undefined) ??
    realtimeIridescence.iridescenceThicknessMap ??
    undefined;
  if (thinFilmMap) {
    material.thinFilmMap = convertTexture(thinFilmMap, textureCache);
  }
  const anisotropy = Number(physicalMaterial.anisotropy);
  material.specularAnisotropy = Number.isFinite(anisotropy)
    ? Math.min(1, Math.max(0, anisotropy))
    : 0;
  const openPbr = standardMaterial.userData.clayptOpenPBR as
    | Record<string, unknown>
    | undefined;
  const finite = (
    value: unknown,
    fallback: number,
    minimum = 0,
    maximum = 1
  ) => {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(maximum, Math.max(minimum, number))
      : fallback;
  };
  const color = (value: unknown, fallback: ColorRGB) => {
    const components = value as ArrayLike<number> | undefined;
    return components && components.length >= 3
      ? ([
          finite(components[0], fallback[0]),
          finite(components[1], fallback[1]),
          finite(components[2], fallback[2])
        ] as ColorRGB)
      : fallback;
  };
  if (openPbr) {
    material.baseWeight = finite(openPbr.baseWeight, material.baseWeight);
    material.baseDiffuseRoughness = finite(
      openPbr.baseDiffuseRoughness,
      material.baseDiffuseRoughness
    );
    material.specularWeight = finite(
      openPbr.specularWeight,
      material.specularWeight
    );
    material.specularColor = color(
      openPbr.specularColor,
      material.specularColor
    );
    material.transmissionScatter = color(
      openPbr.transmissionScatter,
      material.transmissionScatter
    );
    material.transmissionScatterAnisotropy = finite(
      openPbr.transmissionScatterAnisotropy,
      material.transmissionScatterAnisotropy,
      -0.95,
      0.95
    );
    material.transmissionDispersionScale = finite(
      openPbr.transmissionDispersionScale,
      material.transmissionDispersionScale
    );
    material.transmissionDispersionAbbeNumber = finite(
      openPbr.transmissionDispersionAbbeNumber,
      material.transmissionDispersionAbbeNumber,
      1,
      100
    );
    material.subsurfaceWeight = finite(
      openPbr.subsurfaceWeight,
      material.subsurfaceWeight
    );
    material.subsurfaceColor = color(
      openPbr.subsurfaceColor,
      material.subsurfaceColor
    );
    material.subsurfaceRadius = finite(
      openPbr.subsurfaceRadius,
      material.subsurfaceRadius,
      0,
      Infinity
    );
    material.subsurfaceRadiusScale = color(
      openPbr.subsurfaceRadiusScale,
      material.subsurfaceRadiusScale
    );
    material.subsurfaceAnisotropy = finite(
      openPbr.subsurfaceAnisotropy,
      material.subsurfaceAnisotropy,
      -0.95,
      0.95
    );
    material.coatWeight = finite(openPbr.coatWeight, material.coatWeight);
    material.coatColor = color(openPbr.coatColor, material.coatColor);
    material.coatRoughness = finite(
      openPbr.coatRoughness,
      material.coatRoughness
    );
    material.coatAnisotropy = finite(
      openPbr.coatAnisotropy,
      material.coatAnisotropy
    );
    material.coatIor = finite(openPbr.coatIor, material.coatIor, 1, 2.5);
    material.coatDarkening = finite(
      openPbr.coatDarkening,
      material.coatDarkening
    );
    material.fuzzWeight = finite(openPbr.fuzzWeight, material.fuzzWeight);
    material.fuzzColor = color(openPbr.fuzzColor, material.fuzzColor);
    material.fuzzRoughness = finite(
      openPbr.fuzzRoughness,
      material.fuzzRoughness
    );
    if ('thinWalled' in openPbr) {
      material.thinWalled = openPbr.thinWalled === true;
    }
    material.thinFilmWeight = finite(
      openPbr.thinFilmWeight,
      material.thinFilmWeight
    );
    material.thinFilmThickness = finite(
      openPbr.thinFilmThickness,
      material.thinFilmThickness,
      0,
      20
    );
    material.thinFilmIor = finite(
      openPbr.thinFilmIor,
      material.thinFilmIor,
      1,
      2.5
    );
  }
  material.opacity = standardMaterial.opacity;
  // THREE.DoubleSide is the numeric enum value 2. Keep this module's Three.js
  // import type-only while preserving the source material's culling semantics.
  material.doubleSided = standardMaterial.side === 2;
  const bevelSize = Number(standardMaterial.userData.clayptBevelSize);
  material.bevelSize = Number.isFinite(bevelSize) ? Math.max(0, bevelSize) : 0;
  material.mapAlphaUsage =
    standardMaterial.transparent ||
    !!standardMaterial.alphaMap ||
    standardMaterial.alphaTest > 0
    ? OpenPBRMaterial.mapAlphaUsageAlpha
    : OpenPBRMaterial.mapAlphaUsageOpaque;
  material.alphaMode = standardMaterial.alphaTest > 0
    ? 'mask'
    : standardMaterial.transparent ||
        standardMaterial.opacity < 1 ||
        !!standardMaterial.alphaMap
      ? 'blend'
      : 'opaque';

  return material;
}

function copyFloatAttribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
) {
  const result = new Float32Array(attribute.count * attribute.itemSize);
  const getters = [
    attribute.getX,
    attribute.getY,
    attribute.getZ,
    attribute.getW
  ];
  for (let index = 0; index < attribute.count; index++) {
    for (let component = 0; component < attribute.itemSize; component++) {
      result[index * attribute.itemSize + component] = getters[component].call(
        attribute,
        index
      );
    }
  }
  return result;
}

function convertGeometry(
  threeGeometry: THREE.BufferGeometry,
  drawRange?: { start: number; count: number }
): Geometry | null {
  const positionAttrb = threeGeometry.getAttribute('position');
  const normalAttrb = threeGeometry.getAttribute('normal');
  const tangentAttrb = threeGeometry.getAttribute('tangent');
  const uvAttrb = threeGeometry.getAttribute('uv');
  const uv1Attrb = threeGeometry.getAttribute('uv1');
  const indexAttrb = threeGeometry.getIndex();
  const sourceIndices = indexAttrb
    ? Array.from(indexAttrb.array as ArrayLike<number>)
    : Array.from({ length: positionAttrb.count }, (_, index) => index);
  const indices = drawRange
    ? sourceIndices.slice(drawRange.start, drawRange.start + drawRange.count)
    : sourceIndices;
  // WebGL's TRIANGLES draw mode ignores an incomplete final primitive. Keep
  // path tracing on the same index stream so valid BufferGeometry with a
  // dangling one or two elements cannot produce invalid BLAS input.
  indices.length -= indices.length % 3;
  if (indices.length === 0) return null;
  const geometry = new Geometry({
    position: new Attribute(
      copyFloatAttribute(positionAttrb),
      positionAttrb.itemSize
    ),
    normal:
      normalAttrb &&
      new Attribute(copyFloatAttribute(normalAttrb), normalAttrb.itemSize),
    tangent: tangentAttrb && new Attribute(
      copyFloatAttribute(tangentAttrb).filter(
        (_, component) => component % tangentAttrb.itemSize < 3
      ),
      3
    ),
    uv: uvAttrb && new Attribute(copyFloatAttribute(uvAttrb), uvAttrb.itemSize),
    uv1:
      uv1Attrb &&
      new Attribute(copyFloatAttribute(uv1Attrb), uv1Attrb.itemSize),
    indices: new Attribute(new Uint32Array(indices), 1)
  });
  if (!geometry.normal) {
    generateVertexNormals(geometry);
  }
  updateBoundingBox(geometry);
  return geometry;
}

export type FromTHREEGeometryCache = WeakMap<
  THREE.BufferGeometry,
  Map<string, Geometry>
>;

/** Options for {@link fromTHREEScene}. */
export interface FromTHREESceneOptions {
  /**
   * Reuse converted geometry across calls. Pass the same WeakMap when
   * re-converting an animated or edited scene.
   */
  geometryCache?: FromTHREEGeometryCache;
  /** Receives the source mesh/group for each converted core mesh. */
  onMeshConverted?(
    mesh: Mesh,
    source: THREE.Mesh,
    group: { start: number; count: number; materialIndex?: number },
    groupIndex: number
  ): void;
}

/**
 * Converts a Three.js scene into a ClayPT {@link Scene}: meshes with
 * `MeshStandardMaterial` / `MeshPhysicalMaterial` (mapped to OpenPBR),
 * directional, ambient, rect-area, point and spot lights, and the scene
 * background / environment. Call `scene.updateMatrixWorld()` first.
 *
 * Renderer-specific material settings can be supplied through
 * `material.userData`, e.g. `userData.clayptShadowCatcher = true` or
 * `userData.clayptOpenPBR = { ... }` for OpenPBR inputs without a Three.js
 * equivalent.
 */
export function fromTHREEScene(
  scene: THREE.Scene,
  options: FromTHREESceneOptions = {}
) {
  const meshes: Mesh[] = [];
  const lights: SceneLight[] = [];
  // GLTFLoader reuses THREE.Texture instances across materials and meshes.
  // Keep that sharing when converting the scene so repeated references do not
  // become duplicate texture-array layers.
  const textureCache = new WeakMap<THREE.Texture, Texture>();

  function isMesh(node: THREE.Object3D): node is THREE.Mesh {
    return (node as THREE.Mesh).isMesh;
  }
  function isDirectionalLight(
    node: THREE.Object3D
  ): node is THREE.DirectionalLight {
    return (node as THREE.DirectionalLight).isDirectionalLight;
  }
  function isAmbientLight(node: THREE.Object3D): node is THREE.AmbientLight {
    return (node as THREE.AmbientLight).isAmbientLight;
  }
  function isRectAreaLight(node: THREE.Object3D): node is THREE.RectAreaLight {
    return (node as THREE.RectAreaLight).isRectAreaLight;
  }
  function isPointLight(node: THREE.Object3D): node is THREE.PointLight {
    return node.type === 'PointLight';
  }
  function isSpotLight(node: THREE.Object3D): node is THREE.SpotLight {
    return node.type === 'SpotLight';
  }
  function isVisibleInHierarchy(node: THREE.Object3D) {
    let current: THREE.Object3D | null = node;
    while (current) {
      if (!current.visible) return false;
      if (current === scene) break;
      current = current.parent;
    }
    return true;
  }

  scene.updateMatrixWorld(true);
  scene.traverse((child) => {
    if (!isVisibleInHierarchy(child)) return;
    if (isMesh(child)) {
      if (child.userData.viewerEnvironment) return;
      // Viewer-only proxy geometry is already represented by its source mesh.
      if (child.userData.viewerRealtimeDisplacement) return;
      const childMaterials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      if (!child.geometry) {
        console.warn(child, 'must have a geometry property');
      } else if (
        childMaterials.some(
          (material) =>
            !(material as THREE.MeshStandardMaterial).isMeshStandardMaterial &&
            !(material as THREE.MeshBasicMaterial).isMeshBasicMaterial &&
            material.userData.clayptShadowCatcher !== true
        )
      ) {
        console.warn(
          child,
          'must use MeshStandardMaterial or MeshBasicMaterial in order to be rendered.'
        );
      } else {
        const threeMaterials = childMaterials;
        const groups =
          threeMaterials.length > 1 && child.geometry.groups.length
            ? child.geometry.groups
            : [{ start: 0, count: Infinity, materialIndex: 0 }];
        groups.forEach((group, groupIndex) => {
          const count = Number.isFinite(group.count)
            ? group.count
            : (child.geometry.getIndex()?.count ??
              child.geometry.getAttribute('position').count);
          const geometryKey = `${group.start}:${count}`;
          let cachedGeometries = options.geometryCache?.get(child.geometry);
          if (!cachedGeometries && options.geometryCache) {
            cachedGeometries = new Map();
            options.geometryCache.set(child.geometry, cachedGeometries);
          }
          let geometry = cachedGeometries?.get(geometryKey);
          if (!geometry) {
            const convertedGeometry = convertGeometry(child.geometry, {
              start: group.start,
              count
            });
            if (!convertedGeometry) return;
            geometry = convertedGeometry;
            cachedGeometries?.set(geometryKey, geometry);
          }
          const material = convertMaterial(
            threeMaterials[group.materialIndex ?? 0],
            textureCache
          );
          if (
            !geometry.uv &&
            material.uvProjection === 'none' &&
            (
              material.map ||
              material.normalMap ||
              material.emissiveMap ||
              material.metallicRoughnessMap ||
              material.roughnessMap ||
              material.metalnessMap ||
              material.thinFilmMap
            )
          ) {
            material.uvProjection = 'triplanar';
          }
          if (
            material.displacementMap &&
            !geometry.uv &&
            material.displacementUvProjection === 'none'
          ) {
            // Procedural projection keeps displacement usable for vertex-color
            // and sculpt meshes that intentionally contain no TEXCOORD_0.
            material.displacementUvProjection = 'triplanar';
          }
          const mesh = new Mesh(geometry, material);
          const simplificationRatio = Number(
            child.userData.clayptMeshoptSimplificationRatio
          );
          mesh.geometrySimplificationRatio = Number.isFinite(
            simplificationRatio
          )
            ? Math.min(Math.max(simplificationRatio, 0), 1)
            : 1;
          mesh.name =
            child.name ||
            `Mesh ${meshes.length + 1}${groups.length > 1 ? `.${groupIndex + 1}` : ''}`;
          mesh.matrixWorld =
            child.matrixWorld.elements.slice() as mat4.Mat4Array;
          meshes.push(mesh);
          options.onMeshConverted?.(mesh, child, group, groupIndex);
        });
      }
    } else if (isDirectionalLight(child)) {
      lights.push(
        new DirectionalLight(
          child.getWorldPosition(child.position.clone())
            .sub(child.target.getWorldPosition(child.target.position.clone()))
            .toArray(),
          child.color.toArray() as ColorRGB,
          child.intensity
        )
      );
    } else if (isRectAreaLight(child)) {
      const worldMatrix = child.matrixWorld.clone();
      // Shear decomposition can return a non-unit quaternion. The size below
      // carries scale; this approximated rectangle's sampling frame is rigid.
      const worldRotation = child.getWorldQuaternion(child.quaternion.clone()).normalize();
      const worldPosition = child.getWorldPosition(child.position.clone());
      const elements = worldMatrix.elements;
      const widthScale = Math.hypot(elements[0], elements[1], elements[2]);
      const heightScale = Math.hypot(elements[4], elements[5], elements[6]);
      const light = new RectLight(
        [child.width * widthScale, child.height * heightScale],
        child.color.toArray() as ColorRGB,
        child.intensity
      );
      worldMatrix.compose(worldPosition, worldRotation, child.scale.clone().set(1, 1, 1));
      light.matrixWorld = worldMatrix.elements.slice() as mat4.Mat4Array;
      lights.push(light);
    } else if (isSpotLight(child)) {
      const worldPosition = child.getWorldPosition(child.position.clone());
      const worldTarget = child.target.getWorldPosition(
        child.target.position.clone()
      );
      const direction = worldTarget.sub(worldPosition).normalize();
      const outerAngle = (child.angle * 180) / Math.PI;
      const profile = child.userData.clayptIesProfile;
      if (profile != null && !(profile instanceof IESProfile)) {
        throw new Error(
          `THREE.SpotLight "${child.name || '<unnamed>'}" has an invalid clayptIesProfile`
        );
      }
      lights.push(
        new SpotLight(
          worldPosition.toArray(),
          direction.toArray(),
          child.color.toArray() as ColorRGB,
          child.intensity,
          child.userData.clayptRadius ?? 0.01,
          outerAngle * (1 - child.penumbra),
          outerAngle,
          child.distance,
          profile,
          child.userData.clayptIesRotation ?? 0
        )
      );
    } else if (isPointLight(child)) {
      const world = child.matrixWorld.elements;
      const position: [number, number, number] = [
        world[12],
        world[13],
        world[14]
      ];
      lights.push(
        new SphereLight(
          position,
          child.color.toArray() as ColorRGB,
          child.intensity,
          child.userData.clayptRadius ?? 0.25
        )
      );
    } else if (isAmbientLight(child)) {
      lights.push(
        new AmbientLight(child.color.toArray() as ColorRGB, child.intensity)
      );
    }
  });

  const threeEnvironment = scene.environment as THREE.DataTexture | null;
  const environmentLight = threeEnvironment
    ? convertEnvironmentLight(threeEnvironment)
    : undefined;
  if (environmentLight) lights.push(environmentLight);

  const grounded = scene.userData.clayptGroundedSkybox as
    | {
        texture: THREE.DataTexture;
        height: number;
        radius: number;
        groundHeight?: number;
        center?: [number, number];
      }
    | undefined;
  const groundedTexture = grounded && convertDataTexture(grounded.texture);
  const hideEnvironmentBackground =
    scene.userData.clayptHiddenBackground === true;
  const background: GroundedSkyboxBackground | ColorRGBA | Texture | undefined =
    hideEnvironmentBackground
      ? [0, 0, 0, 0]
      : grounded && groundedTexture
        ? {
            type: 'GroundedSkybox',
            map: groundedTexture,
            height: grounded.height,
            radius: grounded.radius,
            groundHeight: grounded.groundHeight,
            center: grounded.center
          }
        : scene.background
          ? (scene.background as THREE.Color).isColor
            ? ([...(scene.background as THREE.Color).toArray(), 1] as ColorRGBA)
            : scene.background === scene.environment && environmentLight
              ? environmentLight.map
              : convertDataTexture(scene.background as THREE.DataTexture)
          : undefined;

  return {
    background,
    meshes,
    lights
  };
}

/** Converts a Three.js perspective or orthographic camera. */
export function fromTHREECamera(
  threeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  aperture?: number
) {
  const camera = (threeCamera as THREE.PerspectiveCamera).fov
    ? new Camera(
        'perspective',
        (threeCamera as THREE.PerspectiveCamera).fov,
        (threeCamera as THREE.PerspectiveCamera).aspect,
        (threeCamera as THREE.PerspectiveCamera).near,
        (threeCamera as THREE.PerspectiveCamera).far
      )
    : new Camera(
        'orthographic',
        (threeCamera as THREE.OrthographicCamera).left,
        (threeCamera as THREE.OrthographicCamera).right,
        (threeCamera as THREE.OrthographicCamera).bottom,
        (threeCamera as THREE.OrthographicCamera).top,
        (threeCamera as THREE.OrthographicCamera).near,
        (threeCamera as THREE.OrthographicCamera).far
      );
  threeCamera.updateWorldMatrix(true, false);
  camera.zoom = threeCamera.zoom;
  camera.matrixWorld =
    threeCamera.matrixWorld.elements.slice() as mat4.Mat4Array;
  if (aperture) {
    camera.aperture = aperture;
  }
  return camera;
}
