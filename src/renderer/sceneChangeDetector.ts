import { openPbrSchema } from '../scene/openPbrSchema.js';
import { materialParametersEqual, materialTexturesChanged } from './materialComparison.generated.js';
export { materialParametersEqual } from './materialComparison.generated.js';
import Mesh from '../scene/Mesh.js';
import InstancedMesh from '../scene/InstancedMesh.js';
import Geometry from '../scene/Geometry.js';
import OpenPBRMaterial, { materialTextureKeys } from '../scene/OpenPBRMaterial.js';
import Texture from '../scene/Texture.js';
import { Scene, SceneBackground } from '../scene/Scene.js';

export interface SceneChanges {
  meshes: 'none' | 'incremental' | 'full';
  transforms: Mesh[];
  colors: InstancedMesh[];
  geometries: Geometry[];
  materials: OpenPBRMaterial[];
  lights: boolean;
  background: boolean;
}

/** Small scalar/identity snapshots for lights, backgrounds and texture metadata. */
export function snapshotFields(object: object): unknown[] {
  const values: unknown[] = [object];
  for (const key of Object.keys(object)) {
    const value = (object as Record<string, unknown>)[key];
    values.push(key);
    if (value instanceof Texture) values.push(...snapshotTexture(value));
    else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      values.push(...Array.from(value as ArrayLike<number>));
    } else values.push(value);
  }
  return values;
}

function snapshotTexture(texture: Texture | undefined): unknown[] {
  return texture ? [texture, texture.version, texture.image, texture.flipY,
    texture.uvScale, texture.uvOffset, texture.uvChannel] : [undefined];
}

export function snapshotsEqual(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

function backgroundSnapshot(background: SceneBackground | undefined) {
  if (background instanceof Texture) return snapshotTexture(background);
  if (Array.isArray(background)) return [background, ...background];
  return background ? snapshotFields(background) : [undefined];
}

function captureMaterialTextures(material: OpenPBRMaterial, out: unknown[]) {
  let i = 0;
  for (const key of materialTextureKeys) {
    const texture = material[key];
    if (typeof texture === 'number') continue;
    if (!texture) { out[i++] = undefined; continue; }
    out[i++] = texture; out[i++] = texture.version; out[i++] = texture.image;
    out[i++] = texture.flipY; out[i++] = texture.uvScale; out[i++] = texture.uvOffset;
    out[i++] = texture.uvChannel;
  }
  out.length = i;
}

// Texture references and metadata have their own snapshot.
const parameterKeys = openPbrSchema.filter(field => field.type !== 'texture').map(field => field.key);

export function snapshotMaterialParameters(material: OpenPBRMaterial, previous?: readonly unknown[]) {
  return parameterKeys.map((key, index) => {
    const value = material[key];
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      const array = value as ArrayLike<number>, prior = previous?.[index];
      if (Array.isArray(prior) && prior.length === array.length) {
        let equal = true;
        for (let i = 0; i < array.length; i++) if (!Object.is(array[i], prior[i])) { equal = false; break; }
        if (equal) return prior;
      }
      return Array.from(array);
    }
    return value;
  });
}

const geometryAttributes = ['position', 'normal', 'tangent', 'uv', 'uv1', 'color', 'indices', 'materialIndex'] as const;
function captureGeometryStorage(geometry: Geometry, out: unknown[]) {
  let i = 0;
  for (const key of geometryAttributes) {
    const attribute = geometry[key];
    out[i++] = attribute?.array; out[i++] = attribute?.array.length; out[i++] = attribute?.itemSize;
  }
}
function geometryStorageMatches(geometry: Geometry, storage: unknown[]) {
  let i = 0;
  for (const key of geometryAttributes) {
    const attribute = geometry[key];
    if (storage[i++] !== attribute?.array || storage[i++] !== attribute?.array.length || storage[i++] !== attribute?.itemSize) return false;
  }
  return true;
}

interface MeshSnapshot {
  mesh: Mesh;
  geometry: Mesh['geometry'];
  version: number;
  instanceVersion?: number;
  instanceCount?: number;
  instanceTransforms?: Float32Array;
  instanceColors?: Float32Array;
  colorVersion?: number;
  dynamic: boolean;
  storage: unknown[];
  materials: OpenPBRMaterial[];
}
interface Snapshot {
  meshList: Mesh[];
  meshes: MeshSnapshot[];
  matrices: Float64Array;
  materials: Map<OpenPBRMaterial, { values: readonly unknown[]; textures: unknown[] }>;
  lightList: Scene['lights'];
  lights: unknown[][];
  background: unknown[];
}

/** Detects edits without accepting them until the pipeline has received the scene. */
export class SceneChangeDetector {
  private _snapshot?: Snapshot;
  private _pending?: Snapshot;
  private _spare?: Snapshot;
  private _seen = new Set<OpenPBRMaterial>();
  detect(scene: Scene): SceneChanges {
    const old = this._snapshot;
    let full = !old || old.meshList !== scene.meshes || old.meshes.length !== scene.meshes.length;
    const transforms: Mesh[] = [];
    const colors: InstancedMesh[] = [];
    const geometries = new Set<Geometry>();
    const materials: OpenPBRMaterial[] = [];
    const seen = this._seen;
    seen.clear();
    for (let i = 0; i < scene.meshes.length; i++) {
      const mesh = scene.meshes[i];
      const prev = old?.meshes[i];
      let instanceChanged = false;
      if (mesh instanceof InstancedMesh) {
        mesh.validate();
        if (prev?.instanceCount !== mesh.count) full = true;
        if (prev?.mesh === mesh && (prev.colorVersion !== mesh.colorsVersion || prev.instanceColors !== mesh.colors)) colors.push(mesh);
        if (prev?.mesh === mesh && (prev.instanceVersion !== mesh.transformsVersion || prev.instanceTransforms !== mesh.transforms)) {
          transforms.push(mesh); instanceChanged = true;
        }
      }
      if (!prev || prev.mesh !== mesh || prev.geometry !== mesh.geometry ||
        prev.dynamic !== mesh.geometry.dynamic || !geometryStorageMatches(mesh.geometry, prev.storage) || prev.materials.length !== mesh.materials.length ||
        prev.materials.some((m, k) => m !== mesh.materials[k])) full = true;
      if (prev?.geometry === mesh.geometry && prev.version !== mesh.geometry.version) geometries.add(mesh.geometry);
      if (prev?.mesh === mesh) {
        for (let k = 0; k < 16; k++) {
          if (!Object.is(mesh.transform[k], old!.matrices[i * 16 + k])) {
            if (!instanceChanged) transforms.push(mesh);
            break;
          }
        }
      }
      for (const material of mesh.materials) {
        if (seen.has(material)) continue;
        seen.add(material);
        const prior = old?.materials.get(material);
        if (!prior || !materialParametersEqual(material, prior.values) ||
          materialTexturesChanged(material, prior.textures)) materials.push(material);
      }
    }
    const lights = scene.lights.map(snapshotFields);
    const background = backgroundSnapshot(scene.background);
    const changes: SceneChanges = {
      meshes: full ? 'full' : transforms.length || colors.length || materials.length || geometries.size ? 'incremental' : 'none',
      transforms, colors, materials, geometries: [...geometries],
      lights: !old || old.lightList !== scene.lights || lights.length !== old.lights.length ||
        lights.some((light, i) => !snapshotsEqual(light, old.lights[i])),
      background: !old || !snapshotsEqual(background, old.background)
    };
    if (changes.meshes !== 'none' || changes.lights || changes.background) {
      // Write into the other buffer: detect never mutates committed state.
      // Repeated detects without commit overwrite the same pending buffer.
      let next = this._spare;
      if (!next || next.meshList !== scene.meshes || next.meshes.length !== scene.meshes.length) {
        next = { meshList: scene.meshes, meshes: [], matrices: new Float64Array(scene.meshes.length * 16),
          materials: new Map(), lightList: scene.lights, lights: [], background: [] };
        this._spare = next;
      }
      scene.meshes.forEach((mesh, i) => {
        let item = next!.meshes[i];
        if (!item) {
          item = { mesh, geometry: mesh.geometry, version: mesh.geometry.version, dynamic: mesh.geometry.dynamic, storage: [],
            materials: [] };
          next!.meshes[i] = item;
        }
        item.mesh = mesh; item.geometry = mesh.geometry; item.version = mesh.geometry.version;
        item.instanceVersion = mesh instanceof InstancedMesh ? mesh.transformsVersion : undefined;
        item.colorVersion = mesh instanceof InstancedMesh ? mesh.colorsVersion : undefined;
        item.instanceColors = mesh instanceof InstancedMesh ? mesh.colors : undefined;
        item.instanceCount = mesh instanceof InstancedMesh ? mesh.count : undefined;
        item.instanceTransforms = mesh instanceof InstancedMesh ? mesh.transforms : undefined;
        item.dynamic = mesh.geometry.dynamic; captureGeometryStorage(mesh.geometry, item.storage);
        item.materials.length = mesh.materials.length;
        for (let k = 0; k < mesh.materials.length; k++) item.materials[k] = mesh.materials[k];
        next!.matrices.set(mesh.transform, i * 16);
      });
      for (const material of next.materials.keys()) if (!seen.has(material)) next.materials.delete(material);
      const changedMaterials = new Set(materials);
      for (const material of seen) {
        const previous = old?.materials.get(material);
        if (previous && !changedMaterials.has(material)) {
          next.materials.set(material, previous);
        } else {
          // Never overwrite a shared committed entry. The other buffer's
          // retired entry can reuse its texture storage; parameter arrays and
          // their reused vector snapshots remain immutable after capture.
          let item = next.materials.get(material);
          if (!item || item === previous) item = { values: [], textures: [] };
          item.values = snapshotMaterialParameters(material, previous?.values);
          captureMaterialTextures(material, item.textures);
          next.materials.set(material, item);
        }
      }
      next.lightList = scene.lights; next.lights = lights; next.background = background;
      this._pending = next;
    } else this._pending = old;
    return changes;
  }

  commit() {
    if (this._pending && this._pending !== this._snapshot) {
      this._spare = this._snapshot;
      this._snapshot = this._pending;
    }
    this._pending = undefined;
  }
  reset() { this._snapshot = this._pending = this._spare = undefined; this._seen.clear(); }
}
