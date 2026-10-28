import type { AnalyticLight } from '../scene/Scene.js';
import { packLightsData } from './lightsData.js';
export * from './lightsData.js';

export function packLightsToBuffer(lights: AnalyticLight[], texturesIndices: number[],
  selectionPmfs: ArrayLike<number> = [], selectionCdfs: ArrayLike<number> = [],
  iesProfileTexelOffsets: ArrayLike<number> = []
) {
  return packLightsData(lights, texturesIndices, i => selectionPmfs[i], i => selectionCdfs[i], i => iesProfileTexelOffsets[i]);
}
