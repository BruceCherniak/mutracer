import Mesh from '../scene/Mesh';
import OpenPBRMaterial, { materialTextureKeys } from '../scene/OpenPBRMaterial';
import Texture from '../scene/Texture';
import { Scene, SceneBackground } from '../scene/Scene';

export interface SceneChanges {
  meshes: 'none' | 'incremental' | 'full';
  transforms: Mesh[];
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

function materialTextures(material: OpenPBRMaterial) {
  return materialTextureKeys.flatMap(key => { const value = material[key]; return typeof value === 'number' ? [] : snapshotTexture(value); });
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

interface MeshSnapshot {
  mesh: Mesh;
  geometry: Mesh['geometry'];
  version: number;
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

  detect(scene: Scene): SceneChanges {
    const old = this._snapshot;
    let full = !old || old.meshList !== scene.meshes || old.meshes.length !== scene.meshes.length;
    const transforms: Mesh[] = [];
    const materials: OpenPBRMaterial[] = [];
    const seen = new Set<OpenPBRMaterial>();
    for (let i = 0; i < scene.meshes.length; i++) {
      const mesh = scene.meshes[i];
      const prev = old?.meshes[i];
      if (!prev || prev.mesh !== mesh || prev.geometry !== mesh.geometry ||
        prev.version !== mesh.geometry.version || prev.materials.length !== mesh.materials.length ||
        prev.materials.some((m, k) => m !== mesh.materials[k]) ||
        prev.simplification !== mesh.geometrySimplificationRatio ||
        prev.uvProjection !== mesh.uvProjection || prev.displacementUvProjection !== mesh.displacementUvProjection ||
        prev.faceLevels !== mesh.displacementFaceLevels || prev.faceHash !== mesh.displacementFaceLevelsHash) full = true;
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
      meshes: full ? 'full' : transforms.length || materials.length ? 'incremental' : 'none',
      transforms, materials,
      lights: !old || old.lightList !== scene.lights || lights.length !== old.lights.length ||
        lights.some((light, i) => !snapshotsEqual(light, old.lights[i])),
      background: !old || !snapshotsEqual(background, old.background)
    };
    if (changes.meshes !== 'none' || changes.lights || changes.background) {
      const matrices = new Float64Array(scene.meshes.length * 16);
      scene.meshes.forEach((mesh, i) => matrices.set(mesh.matrixWorld, i * 16));
      this._pending = {
        meshList: scene.meshes,
        meshes: scene.meshes.map(mesh => ({ mesh, geometry: mesh.geometry, version: mesh.geometry.version,
          materials: mesh.materials.slice(), uvProjection: mesh.uvProjection, displacementUvProjection: mesh.displacementUvProjection, simplification: mesh.geometrySimplificationRatio,
          faceLevels: mesh.displacementFaceLevels, faceHash: mesh.displacementFaceLevelsHash })),
        matrices,
        materials: new Map([...seen].map(m => [m, { version: m.version, textures: materialTextures(m) }])),
        lightList: scene.lights, lights, background
      };
    } else this._pending = old;
    return changes;
  }

  commit() { if (this._pending) this._snapshot = this._pending; this._pending = undefined; }
  reset() { this._snapshot = this._pending = undefined; }
}
