import type OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import type { ColorRGB } from '../types.js';

/** Normal-incidence, single-passage coat absorption for surface emission.
 * coatColor is squared transmittance; emission crosses the coat once.
 * Keep this shared by material packing and both emissive-distribution paths.
 */
export function materialEmission(material: OpenPBRMaterial): ColorRGB {
  const emission: ColorRGB = [
    material.emissionColor[0] * material.emissionLuminance,
    material.emissionColor[1] * material.emissionLuminance,
    material.emissionColor[2] * material.emissionLuminance
  ];
  if (material.unlit || material.shadowCatcher || material.coatWeight <= 0) return emission;
  const coatWeight = Math.min(material.coatWeight, 1);
  for (let channel = 0; channel < 3; channel++) {
    emission[channel] *= 1 + coatWeight * (Math.sqrt(Math.max(material.coatColor[channel], 0)) - 1);
  }
  return emission;
}
