import {shaderCapabilitiesInclude, type ShaderCapabilities} from './shaderCapabilities.js';

function capabilityKey(capabilities: ShaderCapabilities) {
  return `${capabilities.SCENE_CAPABILITIES},${capabilities.MATERIAL_CAPABILITIES},${capabilities.LIGHT_CAPABILITIES}`;
}

function capabilityCount(capabilities: ShaderCapabilities) {
  let count = 0;
  for (let bits of [capabilities.SCENE_CAPABILITIES, capabilities.MATERIAL_CAPABILITIES, capabilities.LIGHT_CAPABILITIES]) {
    while (bits) { bits &= bits - 1; count++; }
  }
  return count;
}

/** Metadata for successful pipelines. Transport and resource layouts never mix. */
export class WGPUShaderCapabilities {
  private variants = new Map<string, {structure: string; capabilities: ShaderCapabilities}>();

  constructor(private capacity = 128) {}

  find(structure: string, required: ShaderCapabilities) {
    const exactKey = structure + ':' + capabilityKey(required);
    let key = exactKey;
    let found = this.variants.get(key);
    if (!found) {
      let count = Infinity;
      for (const [candidateKey, variant] of this.variants) {
        if (variant.structure !== structure || !shaderCapabilitiesInclude(variant.capabilities, required)) continue;
        const candidateCount = capabilityCount(variant.capabilities);
        if (candidateCount <= count) {
          key = candidateKey; found = variant; count = candidateCount;
        }
      }
    }
    if (!found) return;
    this.variants.delete(key);
    this.variants.set(key, found);
    return found.capabilities;
  }

  remember(structure: string, capabilities: ShaderCapabilities) {
    const key = structure + ':' + capabilityKey(capabilities);
    this.variants.delete(key);
    this.variants.set(key, {structure, capabilities});
    if (this.variants.size > this.capacity) this.variants.delete(this.variants.keys().next().value!);
  }

  clear() { this.variants.clear(); }
}
