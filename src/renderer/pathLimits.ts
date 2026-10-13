/** Shared bound on configured scattering depth and total path-loop events. */
export const MAX_PATH_EVENTS = 20;

/** Round and clamp the requested depth; NaN selects the minimum valid depth. */
export function normalizeBounces(bounces: number): number {
  return Math.min(MAX_PATH_EVENTS, Math.max(1, Number.isNaN(bounces) ? 1 : Math.round(bounces)));
}
