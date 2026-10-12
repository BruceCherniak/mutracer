import type Engine from '../../src/Engine';
import type { PrepareOptions } from '../../src/Engine';
import type Mesh from '../../src/scene/Mesh';

/** Exercise CPU preparation and its diagnostics with compact mesh fixtures. */
export async function prepareStats(engine: Engine, fixture: Mesh[] | {meshes: Mesh[]}, options?: PrepareOptions) {
  await engine.prepare({meshes: Array.isArray(fixture) ? fixture : fixture.meshes, lights: []}, options);
  return engine.getDiagnostics()!.bvh!.lastBuild!;
}
