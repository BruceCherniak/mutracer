import { describe, expect, it, vi } from 'vitest';
import Render from '../../src/Render';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import AmbientLight from '../../src/scene/AmbientLight';
import { createCubeGeometry } from '../../src/util/commonGeometry';
import { renderFixture } from '../helpers/renderPipeline';

describe('Engine commits inputs', () => {
  it('preserves the exact values of a double-precision camera matrix', () => {
    const {engine, camera, targets} = renderFixture();
    camera.transform = Array.from(camera.transform); camera.transform[12] = .123456789012345;
    engine.update(); const render = new Render(engine); render.refine();
    const submitted = vi.mocked(targets[0].draw).mock.calls[0][0];
    expect(submitted.transform[12]).toBe(.123456789012345);
    camera.transform[12] = 2; expect(submitted.transform[12]).toBe(.123456789012345); engine.dispose();
  });
  it('uploads one shared scene and keeps queued input independent of uncommitted edits', () => {
    const {engine, pipeline, camera} = renderFixture();
    const material = new OpenPBRMaterial({baseColor: [.2, .3, .4]});
    const geometry = createCubeGeometry(); const mesh = new Mesh(geometry, material);
    const scene = {meshes: [mesh], lights: [new AmbientLight({color: [.5, .5, .5]})], background: [.1, .2, .3, 1] as [number, number, number, number]};
    engine.scene = scene; engine.update();
    const uploaded = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0];
    expect(uploaded[0]).not.toBe(mesh); expect(uploaded[0].geometry.position.array).not.toBe(geometry.position.array);
    expect(uploaded[0].materials[0].baseColor).toEqual([.2, .3, .4]);
    const a = new Render(engine), b = new Render(engine); a.refine(); b.refine();
    const uploads = vi.mocked(pipeline.setMeshes).mock.calls.length;
    material.baseColor[0] = .9; mesh.position = [4, 5, 6]; geometry.position.array[0] += 1; scene.background[0] = .7;
    camera.position = [2, 2, 2]; a.refine(); b.refine();
    expect(pipeline.setMeshes).toHaveBeenCalledTimes(uploads);
    expect(uploaded[0].position).toEqual([0, 0, 0]); expect(uploaded[0].materials[0].baseColor[0]).toBe(.2);
    material.markUpdated(); geometry.markVerticesUpdated(); engine.update();
    expect(uploaded[0].position).toEqual([4, 5, 6]); expect(uploaded[0].materials[0].baseColor[0]).toBe(.9);
    expect(pipeline.setMeshes).toHaveBeenCalledTimes(uploads + 1); engine.dispose();
  });
  it('commits texture pixels with stable snapshot identity', () => {
    const {engine, pipeline} = renderFixture();
    const pixels = new Float32Array([.1, .2, .3, 1]); const texture = new Texture({width: 1, height: 1, data: pixels});
    const material = new OpenPBRMaterial(); material.map = texture;
    engine.scene = {meshes: [new Mesh(createCubeGeometry(), material)], lights: []}; engine.update();
    const uploaded = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0][0].materials[0].map as Texture;
    const committed = uploaded.image as {data: Float32Array};
    pixels[0] = .9; expect(committed.data[0]).toBeCloseTo(.1);
    texture.markUpdated(); engine.update(); expect(committed.data[0]).toBeCloseTo(.9);
    engine.dispose();
  });
  it('switches the single resident scene and invalidates every render', () => {
    const {engine, pipeline} = renderFixture(); const a = new Render(engine), b = new Render(engine); a.refine(); b.refine();
    engine.scene = {meshes: [], lights: []}; expect(engine.update()).toBe(true);
    expect([a.samples, b.samples]).toEqual([0, 0]); expect(pipeline.setMeshes).toHaveBeenCalledTimes(2);
    a.refine(); b.refine(); expect([a.samples, b.samples]).toEqual([1, 1]); engine.dispose();
  });
  it('prepares another scene without touching current GPU inputs or revisions', async () => {
    const {engine, pipeline} = renderFixture(); const render = new Render(engine); render.refine();
    const next = {meshes: [new Mesh(createCubeGeometry(), new OpenPBRMaterial())], lights: []};
    const progress = vi.fn(); await engine.prepare(next, {onProgress: progress});
    expect(pipeline.setMeshes).toHaveBeenCalledOnce(); render.refine(); expect(render.samples).toBe(2);
    expect(progress).toHaveBeenCalled(); engine.dispose();
  });
});
