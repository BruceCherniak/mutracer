import { makeShaderDataDefinitions } from 'webgpu-utils';
import rayTraceCore from '../../src/renderer/wgsl/chunks/rayTraceCore.wgsl';
import { MaterialChangeTracker } from '../../src/renderer/materialChanges';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WGPURayTracePass, { makeRayTraceUniform } from '../../src/renderer/WGPURayTracePass';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';

function makeTriangleMesh() {
  return new Mesh(new Geometry({
    position: new Attribute(new Float32Array([
      -1, -1, 0,
      1, -1, 0,
      0, 1, 0
    ]), 3),
    normal: new Attribute(new Float32Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1
    ]), 3),
    indices: new Attribute(new Uint16Array([0, 1, 2]), 1)
  }), new OpenPBRMaterial());
}

function makeMeshTrackingPass() {
  const pass = Object.create(WGPURayTracePass.prototype) as Pick<WGPURayTracePass, keyof WGPURayTracePass> &
    Record<string, any>;
  pass._materialChanges = new MaterialChangeTracker();
  pass._meshes = [];
  pass._meshSnapshot = [];
  pass._snapshotByMesh = new WeakMap();
  pass._dirtyTransformMeshes = new Set();
  pass._geometriesNeedRefit = new Set();
  return pass;
}


describe('WGPURayTracePass output resource lifetime', () => {
  beforeEach(() => {
    vi.stubGlobal('GPUBufferUsage', {
      UNIFORM: 8,
      STORAGE: 1,
      COPY_DST: 2,
      COPY_SRC: 4
    });
    vi.stubGlobal('GPUTextureUsage', {
      TEXTURE_BINDING: 1,
      COPY_DST: 2
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps every CPU uniform view aligned with the WGSL target options', () => {
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    const uniform = makeRayTraceUniform();
    const layout = makeShaderDataDefinitions(rayTraceCore({ hasDisplacement: false })).structs.RayTraceUniform;
    expect(layout.size).toBe(uniform.buffer.byteLength);
    for (const [key, view] of Object.entries(uniform.views)) {
      expect(layout.fields[key].offset, key).toBe(view.byteOffset);
    }
    expect(uniform.views.bevel[0]).toBe(1);
    expect(uniform.views.dispersionWavelengths[0]).toBe(3);
  });

  it('packs and resets sample counts without touching the sequence seed', () => {
    const device = {
      createBuffer: vi.fn(({ size }: GPUBufferDescriptor) => ({ size, destroy: vi.fn() })),
      createTexture: vi.fn(() => ({ destroy: vi.fn() })),
      createSampler: vi.fn(() => ({})),
      queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() }
    } as unknown as GPUDevice;
    const pass = new WGPURayTracePass(device);
    const uniform = (pass as unknown as { _rtUniform: ReturnType<typeof makeRayTraceUniform> })._rtUniform;
    try {
      uniform.views.sequenceSeed[0] = 12;
      pass.setSampleCount(0);
      expect(uniform.views.sampleCount[0]).toBe(0);
      pass.setSampleCount(7);
      expect(uniform.views.sampleCount[0]).toBe(7);
      pass.setSampleCount(0);
      expect(uniform.views.sampleCount[0]).toBe(0);
      expect(uniform.views.sequenceSeed[0]).toBe(12);
    } finally {
      pass.dispose();
    }
  });

  it('switches resident accumulation buffers without allocating or retiring either target', async () => {
    const createBuffer = vi.fn(({ size }: GPUBufferDescriptor) => ({ size, destroy: vi.fn() }));
    const device = {
      createBuffer, createTexture: vi.fn(() => ({ destroy: vi.fn() })),
      createSampler: () => ({}),
      queue: { writeBuffer() {}, writeTexture() {}, onSubmittedWorkDone: async () => {} }
    } as unknown as GPUDevice;
    const pass = new WGPURayTracePass(device);
    const final = {}, preview = {};
    pass.useTarget(final); pass.setSize(16, 16);
    const finalBuffers = pass.getOutputBuffer();
    pass.useTarget(preview); pass.setSize(8, 8);
    const previewBuffers = pass.getOutputBuffer();
    const count = createBuffer.mock.calls.length;
    for (let i = 0; i < 10; i++) {
      pass.useTarget(final); pass.setSize(16, 16);
      expect(pass.getOutputBuffer()).toEqual(finalBuffers);
      pass.useTarget(preview); pass.setSize(8, 8);
      expect(pass.getOutputBuffer()).toEqual(previewBuffers);
    }
    await Promise.resolve();
    expect(createBuffer).toHaveBeenCalledTimes(count);
    expect(pass.getTargetMemoryBytes(final)).toBe(16 * 16 * 96);
    expect(pass.getTargetMemoryBytes(preview)).toBe(8 * 8 * 96);
    for (const buffer of [...Object.values(finalBuffers), ...Object.values(previewBuffers)]) {
      expect(buffer.destroy).not.toHaveBeenCalled();
    }
    pass.dispose();
  });

  it('grows a stale empty Materials buffer to one WGSL material element', () => {
    const staleBuffer = { size: 200, destroy: vi.fn() };
    const replacementBuffer = { size: 384, destroy: vi.fn() };
    const createBuffer = vi.fn(() => replacementBuffer);
    const writeBuffer = vi.fn();
    const pass = Object.create(WGPURayTracePass.prototype) as any;
    pass._device = {
      createBuffer,
      queue: { writeBuffer }
    };
    pass._needsUpdateBindGroups = false;

    const emptyMaterials = new Float32Array(0);
    const result = pass._updateGPUBuffer(
      'Materials',
      staleBuffer,
      emptyMaterials,
      384
    );

    expect(staleBuffer.destroy).toHaveBeenCalledOnce();
    expect(createBuffer).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Materials',
      size: 384
    }));
    expect(writeBuffer).toHaveBeenCalledWith(
      replacementBuffer,
      0,
      emptyMaterials.buffer
    );
    expect(result).toBe(replacementBuffer);
    expect(pass._needsUpdateBindGroups).toBe(true);
  });

  it('routes a cached mesh subset through the instance-membership update', () => {
    const pass = makeMeshTrackingPass();
    const first = makeTriangleMesh();
    const second = makeTriangleMesh();
    pass.setMeshes([first, second]);
    pass._residentPreparedMeshData = {};
    pass._materialChanges.capture([...first.materials, ...second.materials]);
    pass._residentSnapshotByMesh = new WeakMap(
      pass._meshSnapshot.map((snapshot: { mesh: Mesh }) => [
        snapshot.mesh,
        snapshot
      ])
    );
    pass._needsUpdateMeshData = false;

    expect(pass.setMeshes([first])).toBe(true);
    expect(pass._needsUpdateMeshMembership).toBe(true);
    expect(pass._needsUpdateMeshData).toBe(false);
  });

  it('keeps resized output buffers alive until submitted GPU work completes', async () => {
    let completeSubmittedWork!: () => void;
    const submittedWorkDone = new Promise<void>((resolve) => {
      completeSubmittedWork = resolve;
    });
    const oldBuffers = Array.from({ length: 4 }, () => ({
      size: 16,
      destroy: vi.fn()
    }));
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({
      ...descriptor,
      destroy: vi.fn()
    }));
    const pass = Object.create(WGPURayTracePass.prototype) as Pick<WGPURayTracePass, keyof WGPURayTracePass> &
      Record<string, any>;

    pass._device = {
      createBuffer,
      queue: {
        onSubmittedWorkDone: vi.fn(() => submittedWorkDone)
      }
    };
    pass._rtUniform = {
      views: {
        outputSize: new Float32Array(2)
      }
    };
    pass._targetOutputs = new Map();
    pass._activeTarget = {};
    pass._outColorBuffer = oldBuffers[0];
    pass._outNormalBuffer = oldBuffers[1];
    pass._outAlbedoBuffer = oldBuffers[2];
    pass._outShadowCatcherBuffer = oldBuffers[3];

    pass.setSize(2, 2);

    expect(createBuffer).toHaveBeenCalledTimes(4);
    expect(pass.getOutputBuffer().shadowCatcher.size).toBe(2 * 2 * 48);
    expect(pass.getOutputBuffer().color.size).toBe(2 * 2 * 16);
    oldBuffers.forEach((buffer) => expect(buffer.destroy).not.toHaveBeenCalled());

    completeSubmittedWork();
    await vi.waitFor(() => {
      oldBuffers.forEach((buffer) =>
        expect(buffer.destroy).toHaveBeenCalledOnce()
      );
    });
  });

  it('updates radiance clamping without adding a Pipeline constant', () => {
    const pass = Object.create(WGPURayTracePass.prototype) as
      Pick<WGPURayTracePass, keyof WGPURayTracePass> & Record<string, any>;
    pass._clamping = undefined;
    pass._constants = {};
    pass._rtUniform = { views: { clamping: new Float32Array(1) } };

    expect(pass.setClamping(8)).toBe(true);
    expect(pass._rtUniform.views.clamping[0]).toBe(8);
    expect(pass._constants).not.toHaveProperty('CLAMPING');
    expect(pass.setClamping(8)).toBe(false);
  });

  it('refreshes precomputed bounds when a mesh deforms before its first render', () => {
    const pass = makeMeshTrackingPass();
    const mesh = makeTriangleMesh();
    mesh.geometry.position.array[2] = .5;
    mesh.geometry.markUpdated();
    pass.setMeshes([mesh]);
    expect(pass._geometriesNeedRefit.has(mesh.geometry)).toBe(true);
    pass._geometriesNeedRefit.clear();
    pass.setMeshes([mesh]);
    expect(pass._geometriesNeedRefit.size).toBe(0);
  });
});
