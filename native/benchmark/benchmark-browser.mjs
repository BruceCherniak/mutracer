import Pass from '@core/renderer/WGPURayTracePass.ts';
import Engine from '@core/Engine.ts';
import Render from '@core/Render.ts';
import { referenceScene } from '@reference';
let activePass;
const sampling = Pass.prototype.setSamplingPattern;
Pass.prototype.setSamplingPattern = function (pattern, max) { activePass = this; return sampling.call(this, pattern, max, 12345); };
const preparationCalls = [];
let nesting = 0, iteration = -1;
for (const key of ['_updateMeshData', '_updateMaterialData', '_updateTextures', '_updateLightSamplingData']) {
    const original = Pass.prototype[key];
    Pass.prototype[key] = function (...args) { const outer = nesting++ === 0, t = performance.now(); try {
        return original.apply(this, args);
    }
    finally {
        nesting--;
        if (outer)
            preparationCalls.push({ iteration, key, ms: performance.now() - t });
    } };
}
const pre = document.querySelector('pre');
let progress = '';
const editMode = new URL(location.href).searchParams.get('edits') === '1';
const save = async (path, body) => { const r = await fetch('/save/' + path, { method: 'POST', body }); if (!r.ok)
    throw Error(await r.text()); };
async function web(key, round) {
    const thermal = await (await fetch('/thermal')).json();
    let lastScene;
    const raw = await (await fetch('/input/' + key)).arrayBuffer(), bytes = new Uint8Array(raw), commits = [], pipelineCalls = [];
    const { width, height, flags } = await referenceScene(bytes, 'unused');
    const engine = new Engine({ canvas: document.querySelector('canvas'), backend: 'webgpu' });
    await engine.init();
    const device = engine.device;
    for (const name of ['createComputePipelineAsync', 'createComputePipeline']) {
        const original = device[name].bind(device);
        device[name] = name.endsWith('Async') ? async (desc) => { const t = performance.now(), result = await original(desc); pipelineCalls.push({ iteration, label: desc.label, ms: performance.now() - t }); return result; } : desc => { const t = performance.now(), result = original(desc); pipelineCalls.push({ iteration, label: desc.label, ms: performance.now() - t }); return result; };
    }
    engine.bvhBuilder = 'tinybvh';
    engine.bvhLayout = 'bvh2';
    engine.bvhWorkerCount = 8;
    const render = new Render(engine, { width, height, maxSamples: 64, bounces: 6, bevel: !!(flags & 1), dispersionWavelengths: flags & 2 ? 3 : 1, directLightCandidates: 2, transmissiveOutputAlphaMin: 1 });
    async function commit() {
        const started = performance.now(), { scene, camera } = await referenceScene(bytes, 'unused');
        const parseMs = performance.now() - started;
        lastScene = scene;
        let t = performance.now();
        await engine.prepare(scene);
        const bvhPrepareMs = performance.now() - t;
        if (engine._tinyBvhUnavailable || engine._bvhWorkerUnavailable)
            throw Error('Requested TinyBVH worker backend unavailable');
        engine.scene = scene;
        engine.camera = camera;
        t = performance.now();
        engine.update();
        if (!engine._ready)
            throw Error('Unexpected deferred BVH preparation');
        render._synchronize(64, true);
        await activePass.updatePipeline();
        if (!activePass.isPipelineReady())
            throw Error('Pipeline unavailable');
        await device.queue.onSubmittedWorkDone();
        return { iteration, parseMs, bvhPrepareMs, setupMs: performance.now() - t, totalMs: performance.now() - started, bvh: engine._lastBvhBuild };
    }
    await commit();
    const run = async () => { const t = performance.now(); await render.converge({ samples: 64, samplesPerBatch: 8, sampleSequenceOffset: 0 }); await device.queue.onSubmittedWorkDone(); return performance.now() - t; };
    const initialMs = await run();
    if (editMode) {
        let writeBytes = 0;
        const writeBuffer = device.queue.writeBuffer.bind(device.queue), writeTexture = device.queue.writeTexture.bind(device.queue);
        device.queue.writeBuffer = (buffer, offset, data, dataOffset = 0, size) => { const unit = data.BYTES_PER_ELEMENT ?? 1; writeBytes += (size ?? (data.byteLength / unit - dataOffset)) * unit; return writeBuffer(buffer, offset, data, dataOffset, size); };
        device.queue.writeTexture = (destination, data, layout, size) => { writeBytes += data.byteLength; return writeTexture(destination, data, layout, size); };
        const wire = new Uint32Array(raw);
        let sourceGeometry = 0;
        for (let i = 1; i < wire[4]; i++)
            if (wire[wire[9] + i * 12 + 1] > wire[wire[9] + sourceGeometry * 12 + 1])
                sourceGeometry = i;
        const sourceMesh = lastScene.meshes.findIndex((_, i) => wire[wire[10] + i * 20] === sourceGeometry);
        const mesh = lastScene.meshes[sourceMesh], geometry = mesh.geometry;
        const position = Math.floor(geometry.vertexCount / 2) * 3, oldPosition = geometry.position.array[position], oldX = mesh.transform[12];
        const edits = { transform: [], geometry: [] };
        const apply = async () => { engine.update(); const deadline = performance.now() + 30000; while (!engine._ready) {
            if (performance.now() > deadline)
                throw Error('Timed out preparing edit');
            await new Promise(resolve => setTimeout(resolve, 0));
        } render._synchronize(64, true); await activePass.updatePipeline(); if (!activePass.isPipelineReady())
            throw Error('Edit pipeline unavailable'); await device.queue.onSubmittedWorkDone(); };
        for (const kind of ['transform', 'geometry'])
            for (let iteration = 0; iteration < 12; iteration++) {
                writeBytes = 0;
                const t = performance.now();
                if (kind === 'transform')
                    mesh.transform[12] = oldX + 0.0001;
                else {
                    geometry.position.array[position] = oldPosition + 0.0001;
                    geometry.markVerticesUpdated();
                }
                await apply();
                edits[kind].push({ iteration, ms: performance.now() - t, writeBytes });
                if (kind === 'transform')
                    mesh.transform[12] = oldX;
                else {
                    geometry.position.array[position] = oldPosition;
                    geometry.markVerticesUpdated();
                }
                await apply();
            }
        await save(`edits/${round}-${key}-web/info.json`, JSON.stringify({ key, round, backend: engine.backend, sourceGeometry, sourceMesh, edits }));
        engine.dispose();
        return;
    }
    for (iteration = 0; iteration < 12; iteration++) {
        pre.textContent = progress + ` commit ${iteration + 1}/12`;
        commits.push(await commit());
    }
    const firstMs = await run(), warm = [];
    for (let i = 0; i < 6; i++) {
        pre.textContent = progress + ` render ${i + 1}/6`;
        warm.push(await run());
    }
    const folder = `${round}-${key}-web`;
    for (const kind of ['hdr', 'normal', 'albedo']) {
        const source = activePass.getOutputBuffer()[kind === 'hdr' ? 'color' : kind], size = width * height * 16, buffer = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(source, 0, buffer, 0, size);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const image = new Float32Array(buffer.getMappedRange().slice(0));
        for (let i = 0; i < image.length; i++)
            image[i] /= 64;
        buffer.unmap();
        buffer.destroy();
        await save(folder + '/' + kind + '.bin', image);
    }
    const info = { key, round, thermal, discardRender: 1, discardCommit: 2, width, height, samples: 64, seed: 12345, rawAccumulation: true, preparationCalls, commits, initialMs, firstMs, warm, pipelineCalls, userAgent: navigator.userAgent, backend: engine.backend, workerCount: engine.bvhWorkerCount, bvh: engine._lastBvhBuild, jsHeapBytes: performance.memory?.usedJSHeapSize };
    await save(folder + '/info.json', JSON.stringify(info));
    engine.dispose();
}
try {
    const cases = await (await fetch('/cases')).json(), {rounds} = await (await fetch('/config')).json(), jobs = [];
    for (let round = 0; round < rounds; round++)
        for (const { key } of cases)
            for (const backend of (round % 2 ? ['hardware', 'software', 'web'] : ['web', 'software', 'hardware']))
                jobs.push({ key, round, backend });
    const index = Number(new URL(location.href).searchParams.get('index') ?? 0);
    if (index >= jobs.length) {
        await save(editMode ? 'edits/complete.json' : 'complete.json', JSON.stringify({ complete: true, userAgent: navigator.userAgent }));
        pre.textContent = 'PASS descriptor benchmark';
    }
    else {
        const { key, round, backend } = jobs[index];
        progress = `Group ${index + 1}/${jobs.length}, round ${round + 1}: ${key} ${backend}`;
        pre.textContent = progress;
        if (backend === 'web')
            await web(key, round);
        else {
            const r = await fetch('/native', { method: 'POST', body: JSON.stringify({ key, round, mode: backend === 'software' ? 0 : 1, edits: editMode }) });
            if (!r.ok)
                throw Error(await r.text());
        }
        location.assign('/?index=' + (index + 1) + (editMode ? '&edits=1' : ''));
    }
}
catch (e) {
    pre.textContent = 'FAIL ' + progress + ' ' + String(e.stack ?? e);
    await save('error.txt', pre.textContent);
}
