import rayTraceCompute from './wgsl/rayTrace.compute.js';
import { WGPU_SCENE_FEATURE_BITS } from './WGPUSceneFeatures.js';
import { MATERIAL_TEXTURE_DEFINES } from './materialTextureSlots.js';

export interface WGPUShaderFeatures {
  hasDisplacement: boolean;
  hasAlpha: boolean;
  hasSceneAlpha: boolean;
  hasAnisotropyDirections: boolean;
  hasCoatNormals: boolean;
  blasLayoutMask: number;
}
const definesKeys = ['NUM_MAPS', 'TLAS_STACK_SIZE', 'BLAS_STACK_SIZE', 'NUM_UNIFORM_LIGHTS'];
const constantsNotUsed = [
  ...Object.keys(WGPU_SCENE_FEATURE_BITS), 'USE_BACKGROUND', 'USE_BACKGROUND_MAP',
  'USE_GROUNDED_BACKGROUND', ...MATERIAL_TEXTURE_DEFINES, 'USE_ANISOTROPY_DIRECTIONS',
  'USE_COAT_NORMAL_FRAMES', 'COLOR_OFF', 'USE_VERTEX_COLOR', 'HAS_ALPHA_BLEND', 'HAS_ALPHA_MASK'
];
export function wgpuShaderPreamble(constants: Record<string, boolean | number>, bake = false): string {
  const defineCode = definesKeys.map(key => `const ${key} = ${constants[key]};`).join('\n');
  const keys = Object.keys(constants).sort().filter(key => !definesKeys.includes(key) && !constantsNotUsed.includes(key));
  const constantsCode = keys.map(key => {
    const value = constants[key];
    return `${bake ? 'const' : 'override'} ${key} = ${typeof value === 'boolean' ? (value ? 'true' : 'false') : value.toString()};`;
  }).join('\n');
  return `\n${defineCode}\n${constantsCode}\n`;
}
export function wgpuShaderSource(constants: Record<string, boolean | number>, features: WGPUShaderFeatures, bake = false): string {
  return wgpuShaderPreamble(constants, bake) + rayTraceCompute(features);
}
