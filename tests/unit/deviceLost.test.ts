import {afterEach, expect, it, vi} from 'vitest';
const {loadOIDNNetwork} = vi.hoisted(() => ({loadOIDNNetwork: vi.fn()}));
vi.mock('../../src/renderer/oidnNetwork', () => ({loadOIDNNetwork}));
vi.mock('../../src/renderer/WGPURenderingPipeline', () => ({makeWGPURenderTargets: vi.fn()}));
import Engine from '../../src/Engine';
import Render from '../../src/Render';
import {minimumDeviceLimits} from '../../src/renderer/deviceRequirements';
import {makeWGPURenderTargets} from '../../src/renderer/WGPURenderingPipeline';
import {renderFixture} from '../helpers/renderPipeline';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {createCubeGeometry} from '../../src/util/commonGeometry';
import {getGeometryBvh} from '../../src/renderer/geometryBvh';
const losses: (() => void)[] = [];
function gpu() {let lose!: (info: GPUDeviceLostInfo) => void; const device = {limits: {...minimumDeviceLimits, maxTextureArrayLayers: 256, maxTextureDimension2D: 8192}, features: new Set(),
  queue: {onSubmittedWorkDone: async () => {}}, lost: new Promise<GPUDeviceLostInfo>(resolve => {lose = resolve;}), destroy: vi.fn()} as unknown as GPUDevice;
  const destroy = () => lose({reason: 'destroyed', message: 'test'} as GPUDeviceLostInfo);losses.push(destroy);return {device, lose: destroy};
}
const engines: Engine[] = [];
afterEach(async () => {losses.forEach(lose => lose());losses.length = 0;await Promise.resolve();engines.forEach(e => e.dispose());engines.length = 0;vi.unstubAllGlobals();vi.restoreAllMocks();loadOIDNNetwork.mockReset();});
function setup(supplied = false) {
  const fixture = renderFixture();engines.push(fixture.engine);const first = gpu(), second = gpu();
  vi.mocked(makeWGPURenderTargets).mockReturnValue(fixture.pipeline);
  const requestDevice = vi.fn().mockResolvedValueOnce(first.device).mockResolvedValue(second.device);
  vi.stubGlobal('navigator', {gpu: {requestAdapter: vi.fn(async () => ({features: new Set(), limits: minimumDeviceLimits, requestDevice})), getPreferredCanvasFormat: () => 'bgra8unorm'}});
  const engine = new Engine({canvas: fixture.canvas, backend: 'webgpu', ...(supplied ? {device: first.device} : {})});engines.push(engine);
  engine.scene = fixture.scene; engine.camera = fixture.camera;
  return {...fixture, engine, first, second, requestDevice};
}
it('recovers shared devices together, reuploads complete inputs and preserves CPU BVHs and weights', async () => {
  const {engine,first,second,pipeline,requestDevice,canvas,camera} = setup();
  engine.scene = {meshes: [new Mesh(createCubeGeometry(), new OpenPBRMaterial())], lights: []};
  await engine.prepare(engine.scene); engine.update(); await engine.init();
  const meshes = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0];const bvh = getGeometryBvh(meshes[0].geometry);expect(bvh).toBeDefined();
  const weightLoad = vi.fn(async () => new ArrayBuffer(4));await engine._getWeights('weights', weightLoad);
  const prepare = vi.spyOn(engine, 'prepare');
  const other = new Engine({canvas, backend: 'webgpu'});engines.push(other);other.scene = {meshes: [], lights: []};other.camera = camera;other.update();await other.init();
  expect(other.device).toBe(first.device);const a = new Render(engine), b = new Render(other);a.refine();b.refine();
  const event = vi.fn();engine.on('devicelost', event);first.lose();await Promise.resolve();await Promise.resolve();
  expect(event).toHaveBeenCalledWith({reason: 'destroyed', recovering: true});expect(a.status).toBe('preparing');expect(a.samples).toBe(0);
  engine.update();other.update();await Promise.all([engine.init(), other.init()]);
  expect(engine.device).toBe(second.device);expect(other.device).toBe(second.device);expect(requestDevice).toHaveBeenCalledTimes(2);
  expect(pipeline.setMeshes).toHaveBeenCalledWith(meshes, undefined);expect(getGeometryBvh(meshes[0].geometry)).toBe(bvh);expect(prepare).not.toHaveBeenCalled();
  await engine._getWeights('weights', weightLoad);expect(weightLoad).toHaveBeenCalledOnce();expect(pipeline.setLights).toHaveBeenCalled();expect(pipeline.setBackground).toHaveBeenCalled();
  a.refine();expect(a.samples).toBe(1);second.lose();await Promise.resolve();
});
it('marks supplied-device loss as error and accepts a validated replacement without destroying either device', async () => {
  vi.spyOn(console,'error').mockImplementation(() => {});const {engine,first,second} = setup(true);
  engine.update();await engine.init();const render = new Render(engine);render.refine();const listener = vi.fn();engine.on('devicelost',listener);
  first.lose();await Promise.resolve();expect(listener).toHaveBeenCalledWith({reason:'destroyed',recovering:false});expect(render.status).toBe('error');
  engine.update();expect(render.refine()).toBe('error');expect(engine.lastError?.message).toContain('device lost');
  await expect(engine.setDevice({limits:{}} as GPUDevice)).rejects.toThrow('requirements');
  await engine.setDevice(second.device);expect(render.status).toBe('preparing');engine.update();await engine.init();render.refine();expect(render.samples).toBe(1);
  engine.dispose();expect(first.device.destroy).not.toHaveBeenCalled();expect(second.device.destroy).not.toHaveBeenCalled();
});
it('rejects setDevice for a shared-device engine', async () => {const {engine,second,first} = setup();await expect(engine.setDevice(second.device)).rejects.toThrow('constructed with device');await engine.init();first.lose();await Promise.resolve();});
it('rejects active convergence on loss, without touching its released target in finally', async () => {
  const {engine,first,pipeline,targets} = setup();engine.update();await engine.init();const render = new Render(engine);
  const loss = render.converge({samples:100, samplesPerBatch:1,onProgress: () => first.lose()});
  await expect(loss).rejects.toThrow('device lost');expect(render.status).toBe('preparing');expect(pipeline.dispose).toHaveBeenCalled();expect(targets[0].setOfflineRenderOptions).toHaveBeenCalledTimes(1);
});
it('reloads device-bound OIDN networks', async () => {
  const {engine,first,second} = setup(true);engine.update();await engine.init();
  const old = {dispose:vi.fn(),prepareForImage:vi.fn(async()=>{}),tileExecute:vi.fn()};const next = {...old,dispose:vi.fn(),prepareForImage:vi.fn(async()=>{})};
  loadOIDNNetwork.mockResolvedValueOnce(old).mockResolvedValueOnce(next);
  const render = new Render(engine,{denoiser:{type:'oidn'}});await vi.waitFor(()=>expect(old.prepareForImage).toHaveBeenCalled());
  first.lose();await Promise.resolve();expect(old.dispose).toHaveBeenCalledOnce();await engine.setDevice(second.device);engine.update();await engine.init();render.refine();
  await vi.waitFor(()=>expect(next.prepareForImage).toHaveBeenCalled());expect(loadOIDNNetwork).toHaveBeenCalledTimes(2);
});

it('disposes a network which finishes loading after device loss', async () => {
  vi.spyOn(console,'error').mockImplementation(() => {});const {engine,first} = setup(true);engine.update();await engine.init();
  const old = {dispose:vi.fn(),prepareForImage:vi.fn(async()=>{}),tileExecute:vi.fn()};let finish!: (value: typeof old) => void;
  loadOIDNNetwork.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  new Render(engine,{denoiser:{type:'oidn'}});await vi.waitFor(()=>expect(loadOIDNNetwork).toHaveBeenCalledOnce());
  first.lose();await Promise.resolve();finish(old);await vi.waitFor(()=>expect(old.dispose).toHaveBeenCalledOnce());expect(old.prepareForImage).not.toHaveBeenCalled();
});
