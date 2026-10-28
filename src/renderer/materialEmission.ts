import type MaterialState from '../scene/MaterialState.js';
import type { ColorRGB } from '../types.js';

/** Normal-incidence, single-passage coat absorption for surface emission.
 * coatColor is squared transmittance; emission crosses the coat once.
 * With coatWeightMap, this is raw emission and the conservative light proposal;
 * the shader applies the UV-dependent absorption exactly once.
 * Keep this shared by material packing and both emissive-distribution paths.
 */
export function materialEmission(material: MaterialState): ColorRGB {
  const emission: ColorRGB = [
    material.emissionColor[0] * material.emissionLuminance,
    material.emissionColor[1] * material.emissionLuminance,
    material.emissionColor[2] * material.emissionLuminance
  ];
  if (material.unlit || material.shadowCatcher || material.coatWeight <= 0 || material.coatWeightMap) return emission;
  const coatWeight = Math.min(material.coatWeight, 1);
  emission[0] = emission[0] * (1 + coatWeight * (Math.sqrt(Math.max(material.coatColor[0], 0)) - 1));
  emission[1] = emission[1] * (1 + coatWeight * (Math.sqrt(Math.max(material.coatColor[1], 0)) - 1));
  emission[2] = emission[2] * (1 + coatWeight * (Math.sqrt(Math.max(material.coatColor[2], 0)) - 1));
  return emission;
}
