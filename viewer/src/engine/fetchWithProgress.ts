class DownloadError extends Error {
  constructor(readonly status: number, url: string, statusText: string) {
    super(`${status} ${statusText || 'request failed'}: ${url}`);
  }
}

// Only our public sample repository has a known equivalent GitHub origin.
function sampleOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.host !== 'cdn.jsdelivr.net') return;
    const match = parsed.pathname.match(/^\/gh\/pissang\/mutracer-assets@([^/]+)\/(.+)$/);
    if (match) return `https://raw.githubusercontent.com/pissang/mutracer-assets/${match[1]}/${match[2]}${parsed.search}`;
  } catch { /* Relative and non-HTTP URLs have no sample origin. */ }
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Fetches bytes with two retries for transient failures; samples can use GitHub as a final fallback. */
export async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const fallback = sampleOrigin(url);
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const address = attempt === 2 && fallback ? fallback : url;
    try {
      return await fetchOnce(address, onProgress, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const transient = error instanceof DownloadError
        ? error.status === 408 || error.status === 429 || error.status >= 500 && error.status <= 599
        : error instanceof TypeError;
      if (!transient || attempt === 2) throw error;
      await retryDelay(attempt === 0 ? 250 : 750, signal);
      onProgress?.(0, 0);
    }
  }
}

async function fetchOnce(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new DownloadError(response.status, url, response.statusText);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || !onProgress) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
