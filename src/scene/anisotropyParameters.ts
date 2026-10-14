/** @internal Stable GPU enum; malformed runtime edits must fail explicitly. */
export function specularAnisotropyModelIndex(model: unknown): number {
  if (model === 'openpbr') return 0;
  if (model === 'gltf') return 1;
  throw new Error(`Invalid specularAnisotropyModel: ${String(model)}. Expected openpbr or gltf.`);
}
/** @internal Source scalars are clamped before their texture factors are applied. */
export function finiteAnisotropySource(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}
