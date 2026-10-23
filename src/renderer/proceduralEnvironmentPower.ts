import type { ProceduralEnvironmentSource } from './envMapDistribution.js';

/** Proposal-only power estimate: changing this affects variance, not radiance or PDFs. */
export function proceduralEnvironmentPower(source: ProceduralEnvironmentSource) {
  // Avoid a GPU-to-CPU fence just to choose among environment and analytic lights.
  // The uniform component in light-domain selection keeps every source supported.
  const ambient = source.ambient[0] * .2126 + source.ambient[1] * .7152 + source.ambient[2] * .0722;
  return 4 * Math.PI * (source.intensity + Math.max(0, ambient));
}
