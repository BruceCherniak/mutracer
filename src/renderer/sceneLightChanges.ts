import type { SceneLight } from '../scene/Scene.js';
import { snapshotFields, snapshotsEqual } from './sceneChangeDetector.js';
import { generateEnvMapFromSceneComponents } from './envMapCreation.js';
import type { EnvironmentSource } from './envMapDistribution.js';
import Texture from '../scene/Texture.js';

/** Synthesized environment data is retained across analytic-light edits. */
export class SceneEnvironmentCache {
  private _snapshot: unknown[][] = [];
  private _image?: EnvironmentSource;
  update(lights: readonly SceneLight[]) {
    const ambient = lights.filter(light => light.type === 'AmbientLight');
    const environment = lights.filter(light => light.type === 'EnvironmentLight');
    // Orientation changes only the shader directions, not the radiance or its CDF.
    const next = [...ambient.map(snapshotFields), ...environment.map(light =>
      [light, light.map, light.map.image, light.map.version, light.map.source, light.intensity])];
    if (next.length !== this._snapshot.length ||
      next.some((value, i) => !snapshotsEqual(value, this._snapshot[i]))) {
      this._image = next.length ? generateEnvMapFromSceneComponents(ambient, environment) : undefined;
      this._snapshot = next;
    }
    return this._image;
  }
}

/** Captures values before callers mutate a RectLight or its Texture in place. */
export class RectLightTextureTracker {
  private _snapshot: unknown[] = [];
  private _hadTexture = false;
  update(lights: readonly SceneLight[]) {
    const textures = lights.map(light => light.type === 'RectLight' ? light.texture : undefined);
    const next = textures.flatMap(texture => texture ? [texture, texture.version, texture.image,
      texture.flipY, ...texture.uvScale, ...texture.uvOffset, texture.uvChannel, texture.wrapS, texture.wrapT, texture.colorSpace] : [undefined]);
    const hasTexture = textures.some((texture): texture is Texture => !!texture);
    const changed = (this._hadTexture || hasTexture) && !snapshotsEqual(next, this._snapshot);
    this._snapshot = next;
    this._hadTexture = hasTexture;
    return changed;
  }
}
