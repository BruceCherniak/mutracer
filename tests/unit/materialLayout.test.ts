import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeShaderDataDefinitions } from 'webgpu-utils';
import Material from '../../src/scene/OpenPBRMaterial';
import MaterialTable from '../../src/renderer/MaterialTable';
import {
  materialBufferWgsl, materialLayoutFields, packMaterialBuffer
} from '../../src/renderer/materialLayout';

afterEach(() => { vi.unstubAllGlobals(); });

// Reflection calculates actual WGSL alignment independently of the layout table.
describe('material GPU layout', () => {
  it('matches WGSL offsets and the 416-byte C1 contract', () => {
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    const parsed = makeShaderDataDefinitions(materialBufferWgsl()).structs.MaterialBuffer;
    expect(parsed.size).toBe(26 * 16);
    const fields = materialLayoutFields();
    expect(Object.keys(parsed.fields)).toEqual(fields.map(field => field.name));
    for (const field of fields) expect(parsed.fields[field.name].offset, field.name).toBe(field.offset);
  });

  it('keeps displacement step size, reserved bytes and missing indices in their original slots', () => {
    const table = new MaterialTable([new Material(), new Material()], []);
    table.bufferData.displacementStepSize = [0.02, 0.03];
    table.bufferData.roughnessMapIndex = [3];
    const normal = packMaterialBuffer(table.bufferData);
    for (let material = 0; material < 2; material++) {
      const start = material * 104;
      expect(normal[start + 33]).toBe(0);
      expect(normal[start + 32]).toBe(Math.fround(material === 0 ? 0.02 : 0.03));
      for (const offset of [18]) expect(normal[start + offset]).toBe(0);
      for (const offset of [24, 25, 26, 27, 75, 79, 87, 96]) expect(normal[start + offset]).toBe(-1);
      expect(Array.from(normal.slice(start + 98, start + 102))).toEqual([1, 1, 0, 0]);
    }
    expect(normal[104 + 88]).toBe(-1);
  });
});
