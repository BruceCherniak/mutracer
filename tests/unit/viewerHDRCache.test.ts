import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHDR } from '../../viewer/src/engine/environment';

vi.mock('@meimu/mutracer', async () => import('../../src/util/loadRGBE'));

function onePixelHDR() {
  const header = new TextEncoder().encode('#?RADIANCE\n\n-Y 1 +X 1\n');
  const bytes = new Uint8Array(header.length + 4);
  bytes.set(header);
  bytes.set([128, 64, 32, 129], header.length);
  return bytes.buffer;
}

function mockFilesystem() {
  const files = new Map<string, ArrayBuffer>();
  const abort = vi.fn(async () => {});
  let failWrites = false;
  const directory = {
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name)) {
        if (!options?.create) throw new Error('Not found');
        files.set(name, new ArrayBuffer(0));
      }
      return {
        getFile: async () => new Blob([files.get(name)!]),
        createWritable: async () => {
          let pending = new ArrayBuffer(0);
          return {
            write: async (buffer: ArrayBuffer) => {
              if (failWrites) throw new Error('Quota exceeded');
              pending = buffer.slice(0);
            },
            close: async () => { files.set(name, pending); },
            abort
          };
        }
      };
    }),
    removeEntry: vi.fn(async (name: string) => { files.delete(name); })
  };
  const getDirectory = vi.fn(async () => ({
    getDirectoryHandle: async () => directory
  }));
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  return { files, directory, getDirectory, abort, failWrites: () => { failWrites = true; } };
}

const url = 'https://example.com/studio_1k.hdr';

describe('viewer HDR filesystem cache', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('location', { href: 'https://viewer.example.com/viewer/' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(onePixelHDR(), {
      headers: { 'content-length': String(onePixelHDR().byteLength) }
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('persists original bytes and reloads identical pixels without a network request', async () => {
    const fs = mockFilesystem();
    const progress = vi.fn();
    const downloaded = await loadHDR(url, progress);
    expect(Array.from(downloaded.data)).toEqual([1, 0.5, 0.25, 1]);
    expect([...fs.files.values()]).toEqual([onePixelHDR()]);
    expect(progress).toHaveBeenLastCalledWith(onePixelHDR().byteLength, onePixelHDR().byteLength);

    // No module-level memory cache: each call opens the persistent filesystem.
    const cachedProgress = vi.fn();
    expect(await loadHDR(url, cachedProgress)).toEqual(downloaded);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fs.getDirectory).toHaveBeenCalledTimes(2);
    expect(cachedProgress).toHaveBeenCalledWith(onePixelHDR().byteLength, onePixelHDR().byteLength);
  });

  it('keeps origins, resolutions and query strings separate', async () => {
    const fs = mockFilesystem();
    for (const address of [url, url.replace('1k', '4k'), url + '?v=2', url.replace('example.com', 'other.example.com')]) {
      await loadHDR(address);
    }
    expect(fs.files.size).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('normalizes relative URLs and ignores fragments', async () => {
    const fs = mockFilesystem();
    await loadHDR('./studio.hdr#first');
    await loadHDR('https://viewer.example.com/viewer/studio.hdr#second');
    expect(fs.files.size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('removes corrupt cached bytes and replaces them with a validated download', async () => {
    const fs = mockFilesystem();
    await loadHDR(url);
    const name = [...fs.files.keys()][0];
    fs.files.set(name, new ArrayBuffer(0));
    const repaired = await loadHDR(url);
    expect(Array.from(repaired.data)).toEqual([1, 0.5, 0.25, 1]);
    expect(fs.directory.removeEntry).toHaveBeenCalledWith(name);
    expect(fs.files.get(name)).toEqual(onePixelHDR());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('loads normally without the filesystem API', async () => {
    vi.stubGlobal('navigator', {});
    expect((await loadHDR(url)).width).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back when private storage cannot be opened or read', async () => {
    const fs = mockFilesystem();
    fs.getDirectory.mockRejectedValueOnce(new Error('Storage denied'));
    expect((await loadHDR(url)).width).toBe(1);
    fs.directory.getFileHandle.mockRejectedValueOnce(new Error('Read denied'));
    expect((await loadHDR(url)).width).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts a failed cache write while still returning the downloaded environment', async () => {
    const fs = mockFilesystem();
    fs.failWrites();
    expect((await loadHDR(url)).width).toBe(1);
    expect(fs.abort).toHaveBeenCalledTimes(1);
    expect([...fs.files.values()]).toEqual([new ArrayBuffer(0)]);
  });

  it('does not cache invalid downloads', async () => {
    const fs = mockFilesystem();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not HDR')));
    await expect(loadHDR(url)).rejects.toThrow('Not a Radiance');
    expect(fs.files.size).toBe(0);
  });

  it('preserves network failures without creating cached files', async () => {
    const fs = mockFilesystem();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unavailable', { status: 503 })));
    await expect(loadHDR(url)).rejects.toThrow('503');
    expect(fs.files.size).toBe(0);
  });
});
