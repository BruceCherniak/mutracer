/** Keep small slider steps editable instead of rounding them to zero. */
export function decimalPlacesForStep(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const [coefficient, exponent = '0'] = step.toString().split('e');
  const fraction = coefficient.split('.')[1]?.length ?? 0;
  return Math.min(12, Math.max(0, fraction - Number(exponent)));
}

/** Relative dragging: one step per four pixels, or one doubling per forty pixels. */
export function numberFromDrag(
  value: number, deltaX: number, step: number,
  { min = -Infinity, max = Infinity, log = false }: { min?: number; max?: number; log?: boolean } = {}
) {
  const next = log ? value * Math.pow(2, deltaX / 40) : value + deltaX / 4 * step;
  const rounded = Number((Math.round(next / step) * step).toFixed(decimalPlacesForStep(step)));
  return Math.min(max, Math.max(min, rounded));
}
