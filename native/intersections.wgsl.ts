import {createSceneIntersectionsWgsl} from '../src/renderer/wgsl/chunks/intersect.wgsl.js';
import type {WGPUShaderFeatures} from '../src/renderer/wgpuShaderSource.js';

// This native-only injection keeps the archived hybrid wrapper unchanged until
// the authoritative implementation passes its image gates. Names are selected
// while generating WGSL, never rewritten in the host after generation.
export function nativeHybridIntersections(features: WGPUShaderFeatures): string {
  return createSceneIntersectionsWgsl({...features,
    hasAnisotropyDirections: features.hasAnisotropyDirections || features.hasCoatNormals,
    closestName: 'intersectSceneSoftware', shadowName: 'intersectSceneShadowSoftware'});
}
