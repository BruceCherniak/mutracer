import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithProgress } from '../src/engine/fetchWithProgress';

const sample = 'https://cdn.jsdelivr.net/gh/pissang/mutracer-assets@main/assets/yamaha-mt-09/model.glb';
const origin = 'https://raw.githubusercontent.com/pissang/mutracer-assets/main/assets/yamaha-mt-09/model.glb';

describe('viewer downloads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('recovers from a temporary 503 and reports the successful download', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }));
    vi.stubGlobal('fetch', fetchMock);
    const progress = vi.fn();
    const result = fetchWithProgress(sample, progress);
    await vi.runAllTimersAsync();
    expect(new Uint8Array(await result)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([sample, sample]);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });

  it('uses the same repository path and ref on GitHub after repeated CDN failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('model'));
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchWithProgress(sample.replace('@main', '@v0.1.0'));
    await vi.runAllTimersAsync();
    expect(new TextDecoder().decode(await result)).toBe('model');
    expect(fetchMock.mock.calls[2][0]).toBe(origin.replace('/main/', '/v0.1.0/'));
  });

  it('does not retry missing files', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithProgress(sample)).rejects.toThrow(`404 request failed: ${sample}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    sample,
    'https://cdn.jsdelivr.net/gh/another/repo@main/model.glb',
    'https://example.com/model.glb'
  ])('limits failures to three attempts for %s', async (url) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const failure = expect(fetchWithProgress(url)).rejects.toThrow('503');
    await vi.runAllTimersAsync();
    await failure;
    expect(fetchMock.mock.calls.map(([address]) => address)).toEqual([url, url, url === sample ? origin : url]);
  });

  it('cancels a pending retry immediately when the caller aborts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const failure = expect(fetchWithProgress(sample, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await failure;
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an aborted fetch', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithProgress(sample)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('discards partial bytes and resets progress after a stream failure', async () => {
    let reads = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new Uint8Array([9]));
        else controller.error(new TypeError('Connection closed'));
      }
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(broken))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]))));
    const progress = vi.fn();
    const result = fetchWithProgress(sample, progress);
    await vi.runAllTimersAsync();
    expect(new Uint8Array(await result)).toEqual(new Uint8Array([1, 2]));
    expect(progress.mock.calls).toEqual([[1, 0], [0, 0], [2, 0]]);
  });
});
