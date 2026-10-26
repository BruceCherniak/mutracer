import {vi} from 'vitest';
import {shaderSourceLoader, shaderIdentifierMap, stripShaderFormatting} from './shaderSourceLoader';
import {renameShaderIdentifiers} from '../../scripts/shader-identifiers.mjs';

export const original = shaderSourceLoader(false);
export const stripped = shaderSourceLoader(true);
export const rayTrace = original('src/renderer/wgsl/rayTrace.compute.ts').default;
export const compactRayTrace = stripped('src/renderer/wgsl/rayTrace.compute.ts').default;
const originalNames = new Map([...shaderIdentifierMap].map(([name, compact]) => [compact, name]));
export const tokens = (source: string) => stripShaderFormatting(renameShaderIdentifiers(source, originalNames)).match(/[A-Za-z_][\w]*|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?[uifh]?|>>|<<|&&|\|\||!=|==|<=|>=|\+\+|--|\S/g);

export function gpu() {
  vi.stubGlobal('GPUBufferUsage', {UNIFORM: 1, COPY_DST: 2});
  vi.stubGlobal('GPUShaderStage', {VERTEX: 1, FRAGMENT: 2, COMPUTE: 4});
  return {createBuffer: (descriptor: GPUBufferDescriptor) => ({size: descriptor.size}), queue: {writeBuffer() {}}, createSampler: () => ({})} as unknown as GPUDevice;
}

