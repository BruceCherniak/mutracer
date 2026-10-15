import { describe, expect, it } from 'vitest';
import { prepareHardwareCapture } from '../../native/prepare-hwrt.mjs';
import { loadShaderIdentifierMap } from '../../scripts/shader-identifiers.mjs';

describe('native hardware geometry/identity capture', () => {
  function fixture() {
    const bvh = new ArrayBuffer(4 * 16), words = new Int32Array(bvh);
    words[3] = -1; words.set([0, 1, 2, 0], 8);
    const instances = new ArrayBuffer(2 * 40 * 4);
    const floats = new Float32Array(instances), integers = new Int32Array(instances);
    for (let i = 0; i < 2; i++) {
      integers[i * 40] = 0; integers[i * 40 + 1] = 0;
      floats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 3, 2, 4, 1], i * 40 + 20);
    }
    return { _hasDisplacement: false, _constants: { HAS_ALPHA: false },
      _rtUniform: { views: { bevel: new Int32Array([0]), blasOffset: new Int32Array([0]) } },
      _instancesBuffer: { data: new Uint8Array(instances) }, _bvhBuffer: { data: new Uint8Array(bvh) },
      _attributeData: new Float32Array([0, 0, 0, 99, 1, 0, 0, 99, 0, 1, 0, 99]),
      _attributeStride: 4, _attributeOffsets: [0] };
  }
  it('deduplicates BLASes while preserving leaf-order instance IDs and triangle records', () => {
    const files = new Map<string, Uint8Array | string>();
    const save = (name: string, data: Uint8Array | string) => { files.set(name, data); return name; };
    const identifiers = loadShaderIdentifierMap();
    const source = ['intersectScene', 'intersectSceneShadow'].map(name => `fn ${identifiers.get(name) ?? name}() {}`).join('\n');
    const result = prepareHardwareCapture(fixture(), save, source);
    expect(result.eligible).toBe(true);
    expect(result.hardwareClosest).toBe(true);
    expect(result.geometries).toHaveLength(1);
    expect(result.instances?.map(instance => instance.customIndex)).toEqual([0, 1]);
    expect(result.instances?.[1].transform).toEqual([1, 0, 0, 3, 0, 1, 0, 2, 0, 0, 1, 4]);
    const positions = files.get(result.geometries![0].positions) as Uint8Array;
    expect([...new Float32Array(positions.buffer)]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const map = files.get(result.triangleMap!) as Uint8Array;
    expect([...new Uint32Array(map.buffer)]).toEqual([2, 2, 2]);
  });
  it('retains software closest-hit for nonuniform, reflected or sheared instances', () => {
    const identifiers = loadShaderIdentifierMap();
    const source = ['intersectScene', 'intersectSceneShadow'].map(name => `fn ${identifiers.get(name) ?? name}() {}`).join('\n');
    for (const [offset, value] of [[20, 2], [20, -1], [24, .2]]) {
      const pass = fixture();
      new Float32Array(pass._instancesBuffer.data.buffer)[offset] = value;
      const result = prepareHardwareCapture(pass, name => name, source);
      expect(result.eligible).toBe(true);
      expect(result.hardwareClosest).toBe(false);
    }
  });
  it('refuses alpha/displacement/bevel rather than treating them as opaque', () => {
    for (const name of ['alpha', 'displacement', 'bevel']) {
      const pass = fixture();
      if (name === 'alpha') pass._constants.HAS_ALPHA = true;
      if (name === 'displacement') pass._hasDisplacement = true;
      if (name === 'bevel') pass._rtUniform.views.bevel[0] = 1;
      expect(prepareHardwareCapture(pass, name => name, '').eligible).toBe(false);
    }
  });
  it('rejects unsupported BLAS layouts', () => {
    const pass = fixture(); new Uint32Array(pass._instancesBuffer.data.buffer)[0] = 0x40000000;
    expect(prepareHardwareCapture(pass, name => name, '').eligible).toBe(false);
  });
});
