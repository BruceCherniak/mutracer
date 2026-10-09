import type * as THREE from 'three';
import Mesh from '../scene/Mesh';
import OpenPBRMaterial, { getMaterialHashKey, materialKeys } from '../scene/OpenPBRMaterial';
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
import { GroundedSkyboxBackground, Scene, SceneLight } from '../scene/Scene';
import { mat4 } from '../math';
import { generateVertexNormals, updateBoundingBox, updateDynamicTangents } from './geometry';
import { THREEDeformation, isDeformingMesh } from './threeDeformation';
import { SceneChangeDetector, snapshotsEqual, snapshotFields } from '../renderer/sceneChangeDetector';

interface TextureRecord {
  texture: Texture;
  state: unknown[];
}
type TextureStore = WeakMap<THREE.Texture, TextureRecord>;

function convertTexture(
  threeTexture: THREE.Texture | null | undefined,
  textureStore: TextureStore
) {
  if (!threeTexture) return;
  const state = [threeTexture.version, threeTexture.image, threeTexture.flipY,
    threeTexture.repeat.x, threeTexture.repeat.y, threeTexture.offset.x,
    threeTexture.offset.y, threeTexture.channel];
  const cached = textureStore.get(threeTexture);
  if (cached && snapshotsEqual(cached.state, state)) return cached.texture;
  const image = threeTexture.image as Texture['image'];
  const texture = cached?.texture ?? new Texture(image);
  texture.image = image;
  texture.source = threeTexture;
  texture.flipY = threeTexture.flipY;
  texture.uvScale = [threeTexture.repeat.x, threeTexture.repeat.y];
  texture.uvOffset = [threeTexture.offset.x, threeTexture.offset.y];
  texture.uvChannel = threeTexture.channel === 1 ? 1 : 0;
  if (cached) texture.markUpdated();
  else texture.version = threeTexture.version;
  textureStore.set(threeTexture, { texture, state });
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

function convertDataTexture(threeTexture: THREE.DataTexture | null | undefined, textureStore: TextureStore) {
  if (!threeTexture?.image?.data || !threeTexture.image.width || !threeTexture.image.height) return;
  const previous = textureStore.get(threeTexture);
  const texture = convertTexture(threeTexture, textureStore)!;
  if (previous?.state === textureStore.get(threeTexture)?.state) return texture;
  const source = threeTexture.image.data as ArrayBufferView;
  const data = source instanceof Uint16Array
    ? Float32Array.from(source, halfFloatToFloat)
    : source instanceof Float32Array || source instanceof Uint8Array || source instanceof Int32Array
      ? source : Float32Array.from(source as unknown as ArrayLike<number>);
  texture.image = { data, width: threeTexture.image.width, height: threeTexture.image.height };
  return texture;
}

function convertMaterial(
  threeMaterial: THREE.Material,
  textureCache: TextureStore
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

/** Options for one-shot conversion and persistent Three.js synchronization. */
export interface FromTHREESceneOptions {
  /** Receives each converted mesh/group on every update. Default: no callback. */
  onMeshConverted?(
    mesh: Mesh,
    source: THREE.Mesh,
    group: { start: number; count: number; materialIndex?: number },
    groupIndex: number
  ): void;
}

interface ColorVariant { material: OpenPBRMaterial; version: number; color: ColorRGB }
interface GeometryEntry { state: unknown[]; groups: Map<string, Geometry> }
interface ConversionStore {
  textures: TextureStore;
  materials: WeakMap<THREE.Material, { material: OpenPBRMaterial; hash: string }>;
  geometries: WeakMap<THREE.BufferGeometry, GeometryEntry>;
  deformedGeometries: WeakMap<THREE.Mesh, GeometryEntry>;
  deformations: WeakMap<THREE.Mesh, THREEDeformation>;
  meshes: WeakMap<THREE.Mesh, Map<number, Mesh>>;
  lights: WeakMap<THREE.Object3D | THREE.Texture, SceneLight>;
  instanceMeshes: WeakMap<THREE.Mesh, Map<number, Mesh[]>>;
  colorVariants: WeakMap<THREE.Material, Map<string, ColorVariant>>;
  warned: WeakSet<THREE.Object3D>;
  background?: Scene['background'];
}
function createConversionStore(): ConversionStore {
  return { textures: new WeakMap(), materials: new WeakMap(), geometries: new WeakMap(),
    meshes: new WeakMap(), lights: new WeakMap(), deformedGeometries: new WeakMap(), deformations: new WeakMap(),
    instanceMeshes: new WeakMap(), colorVariants: new WeakMap(), warned: new WeakSet() };
}
function geometryState(geometry: THREE.BufferGeometry, deformation = false) {
  return ['position', 'normal', 'tangent', 'uv', 'uv1', 'index'].flatMap(name => {
    const attribute = name === 'index' ? geometry.index : geometry.getAttribute(name);
    if (!attribute) return [undefined];
    const interleaved = attribute as THREE.InterleavedBufferAttribute;
    const buffer = interleaved.isInterleavedBufferAttribute ? interleaved.data : attribute as THREE.BufferAttribute;
    return [attribute, buffer, deformation && ['position', 'normal', 'tangent'].includes(name) ? undefined : buffer.version, buffer.array, attribute.count, attribute.itemSize,
      attribute.normalized, interleaved.offset, interleaved.data?.stride];
  });
}
function retainLight(store: ConversionStore, source: THREE.Object3D | THREE.Texture, value: SceneLight) {
  const cached = store.lights.get(source);
  if (!cached || cached.type !== value.type) {
    store.lights.set(source, value);
    return value;
  }
  // Matrix and color arrays are retained when unchanged; light identity always is.
  for (const key of Object.keys(value)) {
    const previous = (cached as unknown as Record<string, unknown>)[key];
    const next = (value as unknown as Record<string, unknown>)[key];
    if (Array.isArray(previous) && Array.isArray(next) && snapshotsEqual(previous, next)) continue;
    (cached as unknown as Record<string, unknown>)[key] = next;
  }
  return cached;
}

/**
 * Converts a Three.js scene into a ClayPT {@link Scene}: meshes with
 * `MeshStandardMaterial` / `MeshPhysicalMaterial` (mapped to OpenPBR),
 * directional, ambient, rect-area, point and spot lights, and the scene
 * background / environment. Calls `scene.updateMatrixWorld()` and creates fresh objects on every call.
 * For animation and editing, use {@link THREESceneSync}.
 *
 * Renderer-specific material settings can be supplied through
 * `material.userData`, e.g. `userData.clayptShadowCatcher = true` or
 * `userData.clayptOpenPBR = { ... }` for OpenPBR inputs without a Three.js
 * equivalent.
 */
export function fromTHREEScene(
  scene: THREE.Scene,
  options: FromTHREESceneOptions = {}
) : Scene {
  return convertScene(scene, options, createConversionStore());
}

function convertScene(scene: THREE.Scene, options: FromTHREESceneOptions, store: ConversionStore): Scene {
  const meshes: Mesh[] = [];
  const lights: SceneLight[] = [];
  const textureCache = store.textures;
  const convertedMaterials = new Set<THREE.Material>();
  const refreshedVariants = new Set<THREE.Material>();
  const instanceMatrix = scene.matrixWorld.clone();
  const instanceWorld = scene.matrixWorld.clone();
  const instanceColor: ColorRGB = [1, 1, 1];
  function refreshVariant(entry: ColorVariant, base: OpenPBRMaterial) {
    if (entry.version === base.version) return;
    for (const field of materialKeys) (entry.material as unknown as Record<string, unknown>)[field] = base[field];
    entry.material.baseColor = base.baseColor.map((value, i) => value * entry.color[i]) as ColorRGB;
    // Three.js also applies instanceColor to MeshBasicMaterial's unlit color.
    if (base.unlit) entry.material.emissionColor = base.emissionColor.map((value, i) => value * entry.color[i]) as ColorRGB;
    entry.material.markUpdated();
    entry.version = base.version;
  }
  function colorVariant(source: THREE.Material, base: OpenPBRMaterial, color: ColorRGB) {
    let variants = store.colorVariants.get(source);
    if (!variants) { variants = new Map(); store.colorVariants.set(source, variants); }
    const key = color.join(':');
    let variant = variants.get(key);
    if (!variant) {
      variant = { material: new OpenPBRMaterial(), version: -1, color: color.slice() as ColorRGB };
      variants.set(key, variant);
    }
    refreshVariant(variant, base);
    return variant.material;
  }

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
        const instanced = child as THREE.InstancedMesh;
        const unsupported = (child as THREE.Mesh & { isBatchedMesh?: boolean }).isBatchedMesh ||
          instanced.isInstancedMesh && (!!instanced.morphTexture || (child as THREE.SkinnedMesh).isSkinnedMesh);
        if (unsupported && !store.warned.has(child)) {
          console.warn('ClayPT: BatchedMesh, instanced morph targets and skinned instancing are not supported; converting as an ordinary mesh.', child);
          store.warned.add(child);
        }
        const expand = instanced.isInstancedMesh && !unsupported;
        let deformation: THREEDeformation | undefined;
        let deformed = false;
        if (!unsupported && isDeformingMesh(child)) {
          deformation = store.deformations.get(child);
          if (!deformation?.matches(child.geometry)) {
            deformation = new THREEDeformation(child.geometry); store.deformations.set(child, deformation);
            store.deformedGeometries.delete(child);
          }
          deformed = deformation.update(child);
        }
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
          const state = geometryState(child.geometry, !!deformation);
          let entry = deformation ? store.deformedGeometries.get(child) : store.geometries.get(child.geometry);
          if (!entry || !snapshotsEqual(entry.state, state)) {
            entry = { state, groups: new Map() };
            if (deformation) store.deformedGeometries.set(child, entry);
            else store.geometries.set(child.geometry, entry);
          }
          let geometry = entry.groups.get(geometryKey);
          const newGeometry = !geometry;
          if (!geometry) {
            const converted = convertGeometry(child.geometry, { start: group.start, count });
            if (!converted) return;
            geometry = converted;
            entry.groups.set(geometryKey, geometry);
          }
          if (deformation && (deformed || newGeometry)) {
            geometry.dynamic = true;
            geometry.position.array.set(deformation.position);
            if (deformation.normal) geometry.normal.array.set(deformation.normal);
            if (deformation.tangent && geometry.tangent) geometry.tangent.array.set(deformation.tangent);
            if (!child.geometry.getAttribute('tangent')) updateDynamicTangents(geometry);
            updateBoundingBox(geometry);
            if (!newGeometry) geometry.markUpdated();
          }
          const sourceMaterial = threeMaterials[group.materialIndex ?? 0];
          const cachedMaterial = store.materials.get(sourceMaterial);
          let material = cachedMaterial?.material ?? convertMaterial(sourceMaterial, textureCache);
          if (!convertedMaterials.has(sourceMaterial)) {
            const converted = cachedMaterial ? convertMaterial(sourceMaterial, textureCache) : material;
            material = converted;
          }
          if (!convertedMaterials.has(sourceMaterial)) {
            const hash = getMaterialHashKey(material);
            if (cachedMaterial) {
              if (cachedMaterial.hash !== hash) {
                for (const key of materialKeys) (cachedMaterial.material as unknown as Record<string, unknown>)[key] = material[key];
                cachedMaterial.material.markUpdated();
                cachedMaterial.hash = hash;
              }
              material = cachedMaterial.material;
            } else store.materials.set(sourceMaterial, { material, hash });
            convertedMaterials.add(sourceMaterial);
          } else material = store.materials.get(sourceMaterial)!.material;
          if (!refreshedVariants.has(sourceMaterial)) {
            // Update absent colors too, including when the instance count is zero.
            for (const variant of store.colorVariants.get(sourceMaterial)?.values() ?? []) refreshVariant(variant, material);
            refreshedVariants.add(sourceMaterial);
          }
          let instancesByGroup = store.instanceMeshes.get(child);
          if (!instancesByGroup) { instancesByGroup = new Map(); store.instanceMeshes.set(child, instancesByGroup); }
          let instanceMeshes = instancesByGroup.get(groupIndex);
          if (!instanceMeshes) { instanceMeshes = []; instancesByGroup.set(groupIndex, instanceMeshes); }
          const baseMaterial = material;
          const instanceCount = expand ? instanced.count : 1;
          // Keep the retained prefix when count shrinks; only the tail is removed.
          if (expand) instanceMeshes.length = Math.min(instanceMeshes.length, instanceCount);
          for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex++) {
            material = baseMaterial;
            if (expand && instanced.instanceColor) {
              const color = instanced.instanceColor;
              instanceColor[0] = color.getX(instanceIndex);
              instanceColor[1] = color.getY(instanceIndex);
              instanceColor[2] = color.getZ(instanceIndex);
              material = colorVariant(sourceMaterial, baseMaterial, instanceColor);
            }
            let meshGroups = store.meshes.get(child);
            if (!meshGroups) { meshGroups = new Map(); store.meshes.set(child, meshGroups); }
            let mesh = expand ? instanceMeshes[instanceIndex] : meshGroups.get(groupIndex);
            if (!mesh) {
              mesh = new Mesh(geometry, material);
              // Three.js matrices use doubles. Retain that precision before CPU
              // inverse transforms and bounds calculations, as one-shot conversion did.
              mesh.matrixWorld = child.matrixWorld.elements.slice() as mat4.Mat4Array;
              if (expand) instanceMeshes[instanceIndex] = mesh;
              else meshGroups.set(groupIndex, mesh);
            }
            mesh.geometry = geometry;
            mesh.uvProjection = !geometry.uv && material.uvProjection === 'none' &&
              (material.map || material.normalMap || material.emissiveMap || material.metallicRoughnessMap ||
                material.roughnessMap || material.metalnessMap || material.thinFilmMap) ? 'triplanar' : undefined;
            mesh.displacementUvProjection = !geometry.uv && material.displacementMap &&
              material.displacementUvProjection === 'none' ? 'triplanar' : undefined;
            if (mesh.materials[0] !== material) mesh.materials = [material];
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
            if (expand) {
              instanced.getMatrixAt(instanceIndex, instanceMatrix);
              instanceWorld.multiplyMatrices(child.matrixWorld, instanceMatrix);
            }
            const matrix = expand ? instanceWorld.elements : child.matrixWorld.elements;
            for (let i = 0; i < 16; i++) mesh.matrixWorld[i] = matrix[i];
            meshes.push(mesh);
            options.onMeshConverted?.(mesh, child, group, groupIndex);
          }
        });
      }
    } else if (isDirectionalLight(child)) {
      lights.push(retainLight(store, child,
        new DirectionalLight(
          child.getWorldPosition(child.position.clone())
            .sub(child.target.getWorldPosition(child.target.position.clone()))
            .toArray(),
          child.color.toArray() as ColorRGB,
          child.intensity
        )
      ));
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
      lights.push(retainLight(store, child, light));
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
      lights.push(retainLight(store, child,
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
      ));
    } else if (isPointLight(child)) {
      const world = child.matrixWorld.elements;
      const position: [number, number, number] = [
        world[12],
        world[13],
        world[14]
      ];
      lights.push(retainLight(store, child,
        new SphereLight(
          position,
          child.color.toArray() as ColorRGB,
          child.intensity,
          child.userData.clayptRadius ?? 0.25
        )
      ));
    } else if (isAmbientLight(child)) {
      lights.push(retainLight(store, child,
        new AmbientLight(child.color.toArray() as ColorRGB, child.intensity)
      ));
    }
  });

  const threeEnvironment = scene.environment as THREE.DataTexture | null;
  const environmentMap = convertDataTexture(threeEnvironment, textureCache);
  const environmentLight = threeEnvironment && environmentMap
    ? retainLight(store, threeEnvironment, new EnvironmentLight(environmentMap)) as EnvironmentLight
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
  const groundedTexture = grounded && convertDataTexture(grounded.texture, textureCache);
  const hideEnvironmentBackground =
    scene.userData.clayptHiddenBackground === true;
  let background: GroundedSkyboxBackground | ColorRGBA | Texture | undefined =
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
              : convertDataTexture(scene.background as THREE.DataTexture, textureCache)
          : undefined;

  const oldBackground = store.background;
  if (Array.isArray(background) && Array.isArray(oldBackground) && snapshotsEqual(background, oldBackground)) {
    background = oldBackground;
  } else if (background && oldBackground && !Array.isArray(background) && !Array.isArray(oldBackground)
    && !(background instanceof Texture) && !(oldBackground instanceof Texture)) {
    // Compare by values, ignoring the newly constructed wrapper's identity.
    if (snapshotsEqual(snapshotFields(background).slice(1), snapshotFields(oldBackground).slice(1))) background = oldBackground;
    else { Object.assign(oldBackground, background); background = oldBackground; }
  }
  store.background = background;
  return {
    background,
    meshes,
    lights
  };
}

/** Informational changes; nothing has to be forwarded to the renderer. */
export interface THREESceneChanges {
  transforms: number;
  membership: boolean;
  content: boolean;
  lights: boolean;
  background: boolean;
}

/** Keeps one ClayPT scene in sync with a Three.js scene, reusing unchanged objects. */
export class THREESceneSync {
  readonly scene: Scene;
  private _store = createConversionStore();
  private _detector = new SceneChangeDetector();
  private _disposed = false;

  /** Creates the initial scene. Default options: no conversion callback. */
  constructor(private _source: THREE.Scene, private _options: FromTHREESceneOptions = {}) {
    this.scene = convertScene(_source, _options, this._store);
    this._detector.detect(this.scene);
    this._detector.commit();
  }

  /** Calls updateMatrixWorld and updates the scene in place. */
  update(): THREESceneChanges {
    if (this._disposed) throw new Error('THREESceneSync has been disposed');
    const next = convertScene(this._source, this._options, this._store);
    const membership = !snapshotsEqual(this.scene.meshes, next.meshes);
    if (membership) this.scene.meshes = next.meshes;
    if (!snapshotsEqual(this.scene.lights, next.lights)) this.scene.lights = next.lights;
    this.scene.background = next.background;
    const changes = this._detector.detect(this.scene);
    this._detector.commit();
    return { transforms: changes.transforms.length, membership,
      content: changes.meshes === 'full' || changes.materials.length > 0 || changes.geometries.length > 0,
      lights: changes.lights, background: changes.background };
  }

  /** Releases conversion caches. The last scene remains usable; update then throws. */
  dispose(): void {
    this._store = createConversionStore();
    this._detector.reset();
    this._disposed = true;
  }
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
