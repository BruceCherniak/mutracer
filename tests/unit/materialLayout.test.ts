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
  it.each([false, true])('matches WGSL offsets and the 400-byte C5 contract (TFDM=%s)', tfdm => {
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    const parsed = makeShaderDataDefinitions(materialBufferWgsl(tfdm)).structs.MaterialBuffer;
    expect(parsed.size).toBe(25 * 16);
    const fields = materialLayoutFields(tfdm);
    expect(Object.keys(parsed.fields)).toEqual(fields.map(field => field.name));
    for (const field of fields) expect(parsed.fields[field.name].offset, field.name).toBe(field.offset);
  });

  it('keeps reserved bytes, missing indices and TFDM alternatives in their original slots', () => {
    const table = new MaterialTable([new Material(), new Material()], []);
    table.bufferData.minmaxMapIndex = [7, 9];
    table.bufferData.minmaxMapSize = [128, 256];
    table.bufferData.roughnessMapIndex = [3];
    const normal = packMaterialBuffer(table.bufferData);
    const tfdm = packMaterialBuffer(table.bufferData, true);
    for (let material = 0; material < 2; material++) {
      const start = material * 100;
      expect(normal[start + 33]).toBe(0);
      expect(tfdm[start + 32]).toBe(material === 0 ? 7 : 9);
      expect(tfdm[start + 33]).toBe(material === 0 ? 128 : 256);
      for (let offset = 0; offset < 96; offset++) {
        if (offset !== 32 && offset !== 33) expect(tfdm[start + offset]).toBe(normal[start + offset]);
      }
      for (const offset of [18, 24, 25, 26, 27, 75, 79, 87]) expect(normal[start + offset]).toBe(0);
    }
    expect(normal[100 + 88]).toBe(-1);
  });
});
