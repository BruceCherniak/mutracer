import Mesh from '../scene/Mesh';
import Geometry from '../scene/Geometry';
import OpenPBRMaterial, { materialTextureKeys } from '../scene/OpenPBRMaterial';
import Texture from '../scene/Texture';
import { Scene, SceneBackground } from '../scene/Scene';

export interface SceneChanges {
  meshes: 'none' | 'incremental' | 'full';
  transforms: Mesh[];
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

function texturesChanged(material: OpenPBRMaterial, previous: readonly unknown[]) {
  let i = 0;
  for (const key of materialTextureKeys) {
    const texture = material[key];
    if (typeof texture === 'number') continue;
    if (!texture) { if (previous[i++] !== undefined) return true; continue; }
    if (previous[i++] !== texture || previous[i++] !== texture.version ||
      previous[i++] !== texture.image || previous[i++] !== texture.flipY ||
      previous[i++] !== texture.uvScale || previous[i++] !== texture.uvOffset ||
      previous[i++] !== texture.uvChannel) return true;
  }
  return i !== previous.length;
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
  dynamic: boolean;
  storage: unknown[];
  materials: OpenPBRMaterial[];
  simplification: Mesh['geometrySimplificationRatio'];
  uvProjection: Mesh['uvProjection'];
  displacementUvProjection: Mesh['displacementUvProjection'];
  faceLevels: Mesh['displacementFaceLevels'];
  faceHash: Mesh['displacementFaceLevelsHash'];
}
interface Snapshot {
  meshList: Mesh[];
  meshes: MeshSnapshot[];
  matrices: Float64Array;
  materials: Map<OpenPBRMaterial, { version: number; textures: unknown[] }>;
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
    const geometries = new Set<Geometry>();
    const materials: OpenPBRMaterial[] = [];
    const seen = this._seen;
    seen.clear();
    for (let i = 0; i < scene.meshes.length; i++) {
      const mesh = scene.meshes[i];
      const prev = old?.meshes[i];
      if (!prev || prev.mesh !== mesh || prev.geometry !== mesh.geometry ||
        prev.dynamic !== mesh.geometry.dynamic || !geometryStorageMatches(mesh.geometry, prev.storage) || prev.materials.length !== mesh.materials.length ||
        prev.materials.some((m, k) => m !== mesh.materials[k]) ||
        prev.simplification !== mesh.geometrySimplificationRatio ||
        prev.uvProjection !== mesh.uvProjection || prev.displacementUvProjection !== mesh.displacementUvProjection ||
        prev.faceLevels !== mesh.displacementFaceLevels || prev.faceHash !== mesh.displacementFaceLevelsHash) full = true;
      if (prev?.geometry === mesh.geometry && prev.version !== mesh.geometry.version) geometries.add(mesh.geometry);
      if (prev?.mesh === mesh) {
        for (let k = 0; k < 16; k++) {
          if (!Object.is(mesh.matrixWorld[k], old!.matrices[i * 16 + k])) {
            transforms.push(mesh); break;
          }
        }
      }
      for (const material of mesh.materials) {
        if (seen.has(material)) continue;
        seen.add(material);
        const prior = old?.materials.get(material);
        if (!prior || prior.version !== material.version ||
          texturesChanged(material, prior.textures)) materials.push(material);
      }
    }
    const lights = scene.lights.map(snapshotFields);
    const background = backgroundSnapshot(scene.background);
    const changes: SceneChanges = {
      meshes: full ? 'full' : transforms.length || materials.length || geometries.size ? 'incremental' : 'none',
      transforms, materials, geometries: [...geometries],
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
            materials: [], uvProjection: mesh.uvProjection, displacementUvProjection: mesh.displacementUvProjection,
            simplification: mesh.geometrySimplificationRatio, faceLevels: mesh.displacementFaceLevels,
            faceHash: mesh.displacementFaceLevelsHash };
          next!.meshes[i] = item;
        }
        item.mesh = mesh; item.geometry = mesh.geometry; item.version = mesh.geometry.version;
        item.dynamic = mesh.geometry.dynamic; captureGeometryStorage(mesh.geometry, item.storage);
        item.materials.length = mesh.materials.length;
        for (let k = 0; k < mesh.materials.length; k++) item.materials[k] = mesh.materials[k];
        item.uvProjection = mesh.uvProjection; item.displacementUvProjection = mesh.displacementUvProjection;
        item.simplification = mesh.geometrySimplificationRatio;
        item.faceLevels = mesh.displacementFaceLevels; item.faceHash = mesh.displacementFaceLevelsHash;
        next!.matrices.set(mesh.matrixWorld, i * 16);
      });
      for (const material of next.materials.keys()) if (!seen.has(material)) next.materials.delete(material);
      for (const material of seen) {
        let item = next.materials.get(material);
        if (!item) { item = { version: material.version, textures: [] }; next.materials.set(material, item); }
        item.version = material.version;
        captureMaterialTextures(material, item.textures);
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
