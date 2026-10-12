/** Read the bound RGBA32F framebuffer through a PBO and a non-blocking fence. */
export async function readFloatPixelsAsync(
  gl: WebGL2RenderingContext, width: number, height: number, signal: AbortSignal
) {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('Unable to allocate depth readback buffer.');
  let fence: WebGLSync | null = null;
  const data = new Float32Array(width * height * 4);
  const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
  try {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, data.byteLength, gl.STREAM_READ);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
    fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) throw new Error('Unable to create depth readback fence.');
    gl.flush();
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error('Depth query cancelled.'));
      const poll = () => {
        if (signal.aborted) { abort(); return; }
        const status = gl.clientWaitSync(fence!, 0, 0);
        if (status === gl.WAIT_FAILED || gl.isContextLost()) {
          finish(new Error('Depth readback failed.'));
        } else if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
          finish();
        } else if (performance.now() - started > 5000) {
          finish(new Error('Depth readback timed out.'));
        } else {
          timer = setTimeout(poll, 16);
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      // WebGL fences must be polled in a later task so the browser can submit.
      timer = setTimeout(poll, 0);
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
    return data;
  } finally {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
    if (fence) gl.deleteSync(fence);
    gl.deleteBuffer(buffer);
  }
}

/** Reads the currently bound RGBA target and returns float32 rows from the top. */
export function readRgbaPixels(gl: WebGL2RenderingContext, width: number, height: number, byteEncoded: boolean): Float32Array {
  const source = byteEncoded ? new Uint8Array(width * height * 4) : new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, byteEncoded ? gl.UNSIGNED_BYTE : gl.FLOAT, source);
  const data = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 4; x++) data[y * width * 4 + x] = source[(height - y - 1) * width * 4 + x] / (byteEncoded ? 255 : 1);
  }
  return data;
}
