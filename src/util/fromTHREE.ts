import { markDeformedGeometry } from '../scene/geometryChanges.js';
import type * as THREE from 'three';
import Mesh from '../scene/Mesh.js';
import OpenPBRMaterial, { getMaterialHashKey, materialKeys } from '../scene/OpenPBRMaterial.js';
import Geometry, { Attribute } from '../scene/Geometry.js';
import Texture from '../scene/Texture.js';
import DirectionalLight from '../scene/DirectionalLight.js';
import AmbientLight from '../scene/AmbientLight.js';
import EnvironmentLight from '../scene/EnvironmentLight.js';
import RectLight from '../scene/RectLight.js';
import SphereLight from '../scene/SphereLight.js';
import SpotLight from '../scene/SpotLight.js';
import IESProfile from '../scene/IESProfile.js';
import Camera from '../scene/Camera.js';
import { ColorRGB, ColorRGBA } from '../types.js';
import { GroundedSkyboxBackground, Scene, SceneLight } from '../scene/Scene.js';
import { mat4 } from '../math.js';
import { generateVertexNormals, updateBoundingBox, updateDynamicTangents } from './geometry.js';
import { THREEDeformation, isDeformingMesh } from './threeDeformation.js';
import { SceneChangeDetector, snapshotsEqual, snapshotFields } from '../renderer/sceneChangeDetector.js';

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
  if (threeMaterial.userData.mutracerShadowCatcher === true) {
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
    .mutracerUvProjection;
  if (
    materialUvProjection === 'triplanar' ||
    materialUvProjection === 'spherical' ||
    materialUvProjection === 'cylindrical' ||
    materialUvProjection === 'none'
  ) {
    material.uvProjection = materialUvProjection;
  }
  const materialUvScale = standardMaterial.userData.mutracerUvScale;
  if (Array.isArray(materialUvScale) && materialUvScale.length >= 2) {
    const referenceLength = Math.max(
      Number(standardMaterial.userData.mutracerUvReferenceLength) || 1,
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
  const displacementStepSize = Number(
    standardMaterial.userData.mutracerDisplacementStepSize
  );
  if (Number.isFinite(displacementStepSize)) {
    material.displacementStepSize = Math.max(0.000001, displacementStepSize);
  }
  const uvProjection = standardMaterial.userData
    .mutracerDisplacementUvProjection;
  if (
    uvProjection === 'triplanar' ||
    uvProjection === 'spherical' ||
    uvProjection === 'cylindrical' ||
    uvProjection === 'none'
  ) {
    material.displacementUvProjection = uvProjection;
  }
  const displacementUvScale = Number(
    standardMaterial.userData.mutracerDisplacementUvScale
  );
  if (Number.isFinite(displacementUvScale)) {
    material.displacementUvScale = Math.max(displacementUvScale, 0.000001);
  }
  const bumpStrength = Number(
    standardMaterial.userData.mutracerDisplacementBumpStrength
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
    // mutracerOpenPBR metadata below may provide a different coat IOR.
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
      .mutracerThinFilmMap as THREE.Texture | undefined) ??
    realtimeIridescence.iridescenceThicknessMap ??
    undefined;
  if (thinFilmMap) {
    material.thinFilmMap = convertTexture(thinFilmMap, textureCache);
  }
  const anisotropy = Number(physicalMaterial.anisotropy);
  material.specularAnisotropy = Number.isFinite(anisotropy)
    ? Math.min(1, Math.max(0, anisotropy))
    : 0;
  const openPbr = standardMaterial.userData.mutracerOpenPBR as
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
  const bevelSize = Number(standardMaterial.userData.mutracerBevelSize);
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
  /** Receives each converted mesh/group/instance on every update. Default: no callback. */
  onMeshConverted?(
    mesh: Mesh,
    source: THREE.Mesh,
    group: { start: number; count: number; materialIndex?: number },
    groupIndex: number
  ): void;
}

interface MaterialVariant {
  material: OpenPBRMaterial;
  version: number;
  color?: ColorRGB;
  autoUvProjection: boolean;
  autoDisplacementUvProjection: boolean;
}
interface GeometryEntry { state: unknown[]; groups: Map<string, Geometry>; checkedAt: number }
interface ConversionStore {
  updateId: number;
  textures: TextureStore;
  materials: WeakMap<THREE.Material, { material: OpenPBRMaterial; hash: string }>;
  geometries: WeakMap<THREE.BufferGeometry, GeometryEntry>;
  deformedGeometries: WeakMap<THREE.Mesh, GeometryEntry>;
  deformations: WeakMap<THREE.Mesh, THREEDeformation>;
  meshes: WeakMap<THREE.Mesh, Map<number, Mesh>>;
  lights: WeakMap<THREE.Object3D | THREE.Texture, SceneLight>;
  instanceMeshes: WeakMap<THREE.Mesh, Map<number, Mesh[]>>;
  // Combined instance-color and automatic-projection variants, pruned each update.
  colorVariants: Map<THREE.Material, Map<string, MaterialVariant>>;
  warned: WeakSet<THREE.Object3D>;
  background?: Scene['background'];
}
function createConversionStore(): ConversionStore {
  return { updateId: 0, textures: new WeakMap(), materials: new WeakMap(), geometries: new WeakMap(),
    meshes: new WeakMap(), lights: new WeakMap(), deformedGeometries: new WeakMap(), deformations: new WeakMap(),
    instanceMeshes: new WeakMap(), colorVariants: new Map(), warned: new WeakSet() };
}
const geometryAttributeNames = ['position', 'normal', 'tangent', 'uv', 'uv1', 'index'] as const;
function geometryState(geometry: THREE.BufferGeometry, deformation: boolean) {
  const state: unknown[] = [];
  for (let i = 0; i < geometryAttributeNames.length; i++) {
    const name = geometryAttributeNames[i];
    const attribute = name === 'index' ? geometry.index : geometry.getAttribute(name);
    if (!attribute) { state.push(undefined); continue; }
    const interleaved = attribute as THREE.InterleavedBufferAttribute;
    const buffer = interleaved.isInterleavedBufferAttribute ? interleaved.data : attribute as THREE.BufferAttribute;
    state.push(attribute, buffer, deformation && i < 3 ? undefined : buffer.version, buffer.array, attribute.count, attribute.itemSize,
      attribute.normalized, interleaved.offset, interleaved.data?.stride);
  }
  return state;
}
/** Compare cached fields directly; unchanged geometry creates no snapshot arrays. */
function geometryStateMatches(geometry: THREE.BufferGeometry, state: readonly unknown[], deformation: boolean) {
  let field = 0;
  for (let i = 0; i < geometryAttributeNames.length; i++) {
    const name = geometryAttributeNames[i];
    const attribute = name === 'index' ? geometry.index : geometry.getAttribute(name);
    if (!attribute) {
      if (state[field++] !== undefined) return false;
      continue;
    }
    const interleaved = attribute as THREE.InterleavedBufferAttribute;
    const buffer = interleaved.isInterleavedBufferAttribute ? interleaved.data : attribute as THREE.BufferAttribute;
    if (state[field++] !== attribute || state[field++] !== buffer ||
      !Object.is(state[field++], deformation && i < 3 ? undefined : buffer.version) ||
      state[field++] !== buffer.array || !Object.is(state[field++], attribute.count) ||
      !Object.is(state[field++], attribute.itemSize) || !Object.is(state[field++], attribute.normalized) ||
      !Object.is(state[field++], interleaved.offset) || !Object.is(state[field++], interleaved.data?.stride)) return false;
  }
  return field === state.length;
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
 * Converts a Three.js scene into a MuTracer {@link Scene}: meshes with
 * `MeshStandardMaterial` / `MeshPhysicalMaterial` (mapped to OpenPBR),
 * directional, ambient, rect-area, point and spot lights, and the scene
 * background / environment. Calls `scene.updateMatrixWorld()` and creates fresh objects on every call.
 * CPU-evaluates skinning/morph targets and expands InstancedMesh instances
 * with shared geometry and cached color/projection material variants. Unsupported batched
 * or instanced deformation falls back to an ordinary mesh with a warning.
 * For animation and editing, use {@link THREESceneSync}.
 *
 * Renderer-specific material settings can be supplied through
 * `material.userData`, e.g. `userData.mutracerShadowCatcher = true` or
 * `userData.mutracerOpenPBR = { ... }` for OpenPBR inputs without a Three.js
 * equivalent.
 */
export function fromTHREEScene(
  scene: THREE.Scene,
  options: FromTHREESceneOptions = {}
) : Scene {
  return convertScene(scene, options, createConversionStore());
}

function convertScene(scene: THREE.Scene, options: FromTHREESceneOptions, store: ConversionStore): Scene {
  const updateId = ++store.updateId;
  const meshes: Mesh[] = [];
  const lights: SceneLight[] = [];
  const textureCache = store.textures;
  const convertedMaterials = new Set<THREE.Material>();
  const instanceMatrix = scene.matrixWorld.clone();
  const instanceWorld = scene.matrixWorld.clone();
  const instanceColor: ColorRGB = [1, 1, 1];
  function refreshVariant(entry: MaterialVariant, base: OpenPBRMaterial) {
    if (entry.version === base.version) return;
    for (const field of materialKeys) (entry.material as unknown as Record<string, unknown>)[field] = base[field];
    if (entry.color) {
      const color = entry.color;
      entry.material.baseColor = base.baseColor.map((value, i) => value * color[i]) as ColorRGB;
      // Three.js also applies instanceColor to MeshBasicMaterial's unlit color.
      if (base.unlit) entry.material.emissionColor = base.emissionColor.map((value, i) => value * color[i]) as ColorRGB;
    }
    if (entry.autoUvProjection) entry.material.uvProjection = 'triplanar';
    if (entry.autoDisplacementUvProjection) entry.material.displacementUvProjection = 'triplanar';
    entry.material.markUpdated();
    entry.version = base.version;
  }
  function materialVariant(source: THREE.Material, base: OpenPBRMaterial, color: ColorRGB | undefined,
    autoUvProjection: boolean, autoDisplacementUvProjection: boolean) {
    if (!color && !autoUvProjection && !autoDisplacementUvProjection) return base;
    let variants = store.colorVariants.get(source);
    if (!variants) { variants = new Map(); store.colorVariants.set(source, variants); }
    const key = `${color?.join(':') ?? ''}|${+autoUvProjection}:${+autoDisplacementUvProjection}`;
    let variant = variants.get(key);
    if (!variant) {
      variant = { material: new OpenPBRMaterial(), version: -1, color: color?.slice() as ColorRGB | undefined,
        autoUvProjection, autoDisplacementUvProjection };
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
  scene.updateMatrixWorld(true);
  scene.traverseVisible((child) => {
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
            material.userData.mutracerShadowCatcher !== true
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
          console.warn('MuTracer: BatchedMesh, instanced morph targets and skinned instancing are not supported; converting as an ordinary mesh.', child);
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
        // Shared static geometry is checked once per update, before its groups.
        // Deforming meshes keep independent entries for their evaluated geometry.
        let entry = deformation ? store.deformedGeometries.get(child) : store.geometries.get(child.geometry);
        if (!entry || entry.checkedAt !== updateId) {
          if (!entry || !geometryStateMatches(child.geometry, entry.state, !!deformation)) {
            entry = { state: geometryState(child.geometry, !!deformation), groups: new Map(), checkedAt: updateId };
            if (deformation) store.deformedGeometries.set(child, entry);
            else store.geometries.set(child.geometry, entry);
          }
          entry.checkedAt = updateId;
        }
        const geometryEntry = entry;
        groups.forEach((group, groupIndex) => {
          const count = Number.isFinite(group.count)
            ? group.count
            : (child.geometry.getIndex()?.count ??
              child.geometry.getAttribute('position').count);
          const geometryKey = `${group.start}:${count}`;
          let geometry = geometryEntry.groups.get(geometryKey);
          const newGeometry = !geometry;
          if (!geometry) {
            const converted = convertGeometry(child.geometry, { start: group.start, count });
            if (!converted) return;
            geometry = converted;
            geometryEntry.groups.set(geometryKey, geometry);
          }
          if (deformation && (deformed || newGeometry)) {
            geometry.dynamic = true;
            geometry.position.array.set(deformation.position);
            if (deformation.normal) geometry.normal.array.set(deformation.normal);
            if (deformation.tangent && geometry.tangent) geometry.tangent.array.set(deformation.tangent);
            if (!child.geometry.getAttribute('tangent')) updateDynamicTangents(geometry);
            updateBoundingBox(geometry);
            if (!newGeometry) markDeformedGeometry(geometry);
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
          let instancesByGroup = store.instanceMeshes.get(child);
          if (!instancesByGroup) { instancesByGroup = new Map(); store.instanceMeshes.set(child, instancesByGroup); }
          let instanceMeshes = instancesByGroup.get(groupIndex);
          if (!instanceMeshes) { instanceMeshes = []; instancesByGroup.set(groupIndex, instanceMeshes); }
          const baseMaterial = material;
          const autoUvProjection = !geometry.uv && baseMaterial.uvProjection === 'none' &&
            !!(baseMaterial.map || baseMaterial.normalMap || baseMaterial.emissiveMap || baseMaterial.metallicRoughnessMap ||
              baseMaterial.roughnessMap || baseMaterial.metalnessMap || baseMaterial.thinFilmMap);
          const autoDisplacementUvProjection = !geometry.uv && !!baseMaterial.displacementMap &&
            baseMaterial.displacementUvProjection === 'none';
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
            }
            material = materialVariant(sourceMaterial, baseMaterial,
              expand && instanced.instanceColor ? instanceColor : undefined,
              autoUvProjection, autoDisplacementUvProjection);
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
            if (mesh.materials[0] !== material) mesh.materials = [material];
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
      const profile = child.userData.mutracerIesProfile;
      if (profile != null && !(profile instanceof IESProfile)) {
        throw new Error(
          `THREE.SpotLight "${child.name || '<unnamed>'}" has an invalid mutracerIesProfile`
        );
      }
      lights.push(retainLight(store, child,
        new SpotLight(
          worldPosition.toArray(),
          direction.toArray(),
          child.color.toArray() as ColorRGB,
          child.intensity,
          child.userData.mutracerRadius ?? 0.01,
          outerAngle * (1 - child.penumbra),
          outerAngle,
          child.distance,
          profile,
          child.userData.mutracerIesRotation ?? 0
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
          child.userData.mutracerRadius ?? 0.25
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

  const grounded = scene.userData.mutracerGroundedSkybox as
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
    scene.userData.mutracerHiddenBackground === true;
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
  // Inspect the final converted meshes, including onMeshConverted overrides.
  // Iterate across source materials so removed/hidden objects are pruned too.
  const usedMaterials = new Set(meshes.flatMap(mesh => mesh.materials));
  for (const [source, variants] of store.colorVariants) {
    for (const [key, variant] of variants) if (!usedMaterials.has(variant.material)) variants.delete(key);
    if (!variants.size) store.colorVariants.delete(source);
  }
  return {
    background,
    meshes,
    lights
  };
}

/** Informational changes; nothing has to be forwarded to the renderer. */
export interface THREESceneChanges {
  /** Number of mesh instances with changed transforms. */
  transforms: number;
  /** Whether mesh membership changed during the update. */
  membership: boolean;
  /** Whether geometry or material content changed during the update. */
  content: boolean;
  /** Whether light membership or parameters changed during the update. */
  lights: boolean;
  /** Whether the background changed during the update. */
  background: boolean;
}

/**
 * Keeps one MuTracer scene in sync with a Three.js scene, reusing unchanged objects.
 * Skinning/morph targets run on the CPU with per-source-mesh dynamic geometry.
 * InstancedMesh retains its prefix on count changes and shares geometry/BLAS;
 * Currently used colors and automatic UV-less projections share cached material
 * variants per source material. Source edits refresh variants; unused variants
 * are removed after each update.
 */
export class THREESceneSync {
  /** Retained MuTracer scene initialized from the source scene and updated in place. */
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

  /** Updates world/bone matrices, changed CPU deformation and retained instances in place. */
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
