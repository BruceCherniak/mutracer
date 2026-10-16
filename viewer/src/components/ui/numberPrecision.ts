/** Keep small slider steps editable instead of rounding them to zero. */
export function decimalPlacesForStep(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const [coefficient, exponent = '0'] = step.toString().split('e');
  const fraction = coefficient.split('.')[1]?.length ?? 0;
  return Math.min(12, Math.max(0, fraction - Number(exponent)));
}
