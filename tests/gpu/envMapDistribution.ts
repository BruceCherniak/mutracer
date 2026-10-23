import { WGPUEnvMapDistribution } from '../../src/renderer/WGPUEnvMapDistribution.js';
import { envMapDistribution } from '../../src/renderer/envMapDistribution.js';

/** Compares CDFs and PDFs, including both scan boundaries and map padding. */
export async function runEnvMapDistributionChecks() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU is required');
  const device = await adapter.requestDevice();
  const failures: string[] = [];
  device.addEventListener('uncapturederror', event => failures.push((event as GPUUncapturedErrorEvent).error.message));
  const builder = new WGPUEnvMapDistribution(device);
  const results = [];
  try {
    for (const [width, height, black] of [[1, 1, 0], [1, 5, 0], [5, 1, 0], [17, 7, 1], [257, 513, 0], [2048, 1024, 0]]) {
      const data = Float32Array.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? 1 : black ? 0 : ((i * 17) % 31) / 32);
      // A narrow HDR light near a scan boundary, plus bright seam/pole texels.
      if (!black) for (const index of [0, Math.min(255, width - 1), width * height - 1]) {
        data[index * 4] = 2000; data[index * 4 + 1] = 1500; data[index * 4 + 2] = 1000;
      }
      const source = { data, width, height };
      let started = performance.now();
      const expected = envMapDistribution(source);
      const cpuMs = performance.now() - started;
      const input = device.createTexture({ size: [width, height], format: 'rgba32float', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
      const output = device.createTexture({ size: [width + 2, height + 1], format: 'rg32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
      device.queue.writeTexture({ texture: input }, data, { bytesPerRow: width * 16 }, [width, height]);
      started = performance.now();
      builder.build(input, output);
      const encodeMs = performance.now() - started;
      await device.queue.onSubmittedWorkDone();
      const gpuWallMs = performance.now() - started;
      const bytesPerRow = Math.ceil((width + 2) * 8 / 256) * 256;
      const buffer = device.createBuffer({ size: bytesPerRow * (height + 1), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow }, [width + 2, height + 1]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const actual = new Float32Array(buffer.getMappedRange());
      let cdfError = 0, pdfRelativeError = 0;
      for (let y = 0; y <= height; y++) for (let x = 0; x < width + 2; x++) {
        const a = (y * bytesPerRow / 8 + x) * 2, e = (y * (width + 2) + x) * 2;
        cdfError = Math.max(cdfError, Math.abs(actual[a] - expected.data[e]));
        pdfRelativeError = Math.max(pdfRelativeError, Math.abs(actual[a + 1] - expected.data[e + 1]) / Math.max(1, Math.abs(expected.data[e + 1])));
        if (y < height && x > 1 && actual[a] < actual[a - 2]) throw new Error('Non-monotonic row CDF');
      }
      results.push({ width, height, black: !!black, cdfError, pdfRelativeError, cpuMs, encodeMs, gpuWallMs });
      buffer.unmap(); buffer.destroy(); input.destroy(); output.destroy();
      if (!(cdfError < 5e-5 && pdfRelativeError < 5e-5)) throw new Error(JSON.stringify(results.at(-1)));
    }
    if (failures.length) throw new Error(failures.join('\n'));
    return results;
  } finally { builder.dispose(); device.destroy(); }
}

if (document.querySelector('#summary')) {
  runEnvMapDistributionChecks().then(results => {
    document.querySelector('#summary')!.textContent = JSON.stringify({ passed: true, results });
  }).catch(error => { document.querySelector('#summary')!.textContent = String(error.stack ?? error); });
}
