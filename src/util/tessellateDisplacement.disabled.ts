// The standalone dist builds do not expose displacement tessellation yet.
// Keep pixel transfer and statistics available for ordinary BVH precomputation.
import type { tessellateDisplacementGeometry as Tessellator } from './tessellateDisplacement.js';

export {
  copyDisplacementTextureData,
  getDisplacementTessellationStats,
  setDisplacementTessellationStats
} from './displacementData.js';

export const tessellateDisplacementGeometry: typeof Tessellator = () => {
  throw new Error('Displacement tessellation is not available in the standalone MuTracer build. Use displacementMode: "projective".');
};
