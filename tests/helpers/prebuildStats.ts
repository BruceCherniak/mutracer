import type Renderer from '../../src/Renderer';
import type { PrebuildBVHOptions } from '../../src/Renderer';

/** Exercise the public preparation and diagnostics contracts together. */
export async function prebuildStats(renderer: Renderer, scene: Parameters<Renderer['prebuildBVH']>[0], options?: PrebuildBVHOptions) {
  await renderer.prebuildBVH(scene, options);
  return renderer.getDiagnostics()!.bvh!.lastBuild!;
}
