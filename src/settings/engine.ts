import type Engine from '../Engine.js';
import type { EngineParams } from '../Engine.js';
import type { BvhBuildConfig } from '../renderer/geometryBvh.js';
import { DEFAULT_MAX_TEXTURE_ARRAY_BYTES } from '../renderer/MergedMaterialData.js';
import { resolveBvhWorkerCount } from '../renderer/bvhWorkerClient.js';

declare const process: { env: { NODE_ENV?: string } };
function isDevelopment() { try { return process.env.NODE_ENV !== 'production'; } catch { return false; } }
const both = ['webgpu', 'webgl'] as const;
export const engineSchema = [
  {key: 'bvhBuilder', default: 'builtin', kind: 'bvh', backends: both, parameter: 'builder'},
  {key: 'bvhLayout', default: 'bvh2', kind: 'bvh', backends: both, parameter: 'layout'},
  {key: 'bvhSpatialSplits', default: false, kind: 'bvh', backends: both, parameter: 'spatialSplits'},
  // Worker count changes execution only, without invalidating existing BLASes.
  {key: 'bvhWorkerCount', default: 'auto', kind: 'bvh', backends: both, normalize: resolveBvhWorkerCount},
  {key: 'textureAtlasBudgetBytes', default: DEFAULT_MAX_TEXTURE_ARRAY_BYTES, kind: 'resources', backends: both},
] as const satisfies readonly {key: keyof Engine; default: unknown; kind: 'bvh' | 'resources'; backends: readonly string[]; parameter?: string; normalize?: (value: number | 'auto') => number}[];
// validateUpdates is construction-only in the existing API, not an Engine field.
export const engineDebugSchema = [{key: 'validateUpdates', default: isDevelopment, kind: 'debug', backends: both}] as const;
export function debugSettings(params: EngineParams) {
  return Object.fromEntries(engineDebugSchema.map(field => [field.key, params[field.key] ?? field.default()])) as {validateUpdates: boolean};
}
export function bvhConfig(engine: Engine): BvhBuildConfig {
  return Object.fromEntries(engineSchema.flatMap(field => 'parameter' in field ? [[field.parameter, engine[field.key]]] : [])) as unknown as BvhBuildConfig;
}
export function engineSettingsKey(engine: Engine, kind: 'bvh' | 'resources') {
  return JSON.stringify(engineSchema.filter(field => field.kind === kind && !('normalize' in field)).map(field => engine[field.key]));
}
export function workerCount(engine: Engine) {
  const field = engineSchema.find(field => 'normalize' in field)!;
  return 'normalize' in field ? field.normalize(engine.bvhWorkerCount) : 1;
}
export function textureBudget(engine: Engine) {
  const field = engineSchema.find(field => field.kind === 'resources')!;
  return engine[field.key] as number;
}
