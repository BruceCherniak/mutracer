import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {prepareTinyBvh} from '../../scripts/fetch-tinybvh.mjs';

const contents = Buffer.from('test upstream header\n');
const manifest = {
  revision: '0123456789abcdef0123456789abcdef01234567',
  version: 'test',
  files: ['tiny_bvh.h', 'tiny_bvh_base.h'].map(file => ({
    file, sha256: createHash('sha256').update(contents).digest('hex')
  }))
};
const temporary: string[] = [];
async function cacheRoot() {
  const path = await mkdtemp(join(tmpdir(), 'mutracer-tinybvh-test-'));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

describe('TinyBVH dependency preparation', () => {
  it('downloads the pinned files and reuses verified cache without a network request', async () => {
    const root = await cacheRoot();
    const fetchImpl = vi.fn(async (_url: string) => new Response(contents));
    const include = await prepareTinyBvh({cacheRoot: root, manifest, fetchImpl});
    expect(include).toBe(join(root, manifest.revision));
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(manifest.files.map(({file}) =>
      `https://raw.githubusercontent.com/jbikker/tinybvh/${manifest.revision}/${file}`));
    for (const {file} of manifest.files) expect(await readFile(join(include, file))).toEqual(contents);
    const offline = vi.fn(async () => { throw new Error('offline'); });
    expect(await prepareTinyBvh({cacheRoot: root, manifest, fetchImpl: offline})).toBe(include);
    expect(offline).not.toHaveBeenCalled();
    expect(await readdir(include)).toEqual(manifest.files.map(({file}) => file));
  });

  it('repairs corrupt cache files while retaining valid ones', async () => {
    const root = await cacheRoot();
    const fetchImpl = vi.fn(async () => new Response(contents));
    const include = await prepareTinyBvh({cacheRoot: root, manifest, fetchImpl});
    await writeFile(join(include, 'tiny_bvh.h'), 'corrupt');
    fetchImpl.mockClear();
    await prepareTinyBvh({cacheRoot: root, manifest, fetchImpl});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readFile(join(include, 'tiny_bvh.h'))).toEqual(contents);
  });

  it('rejects a checksum mismatch without publishing an invalid header', async () => {
    const root = await cacheRoot();
    const fetchImpl = vi.fn(async () => new Response('wrong contents'));
    await expect(prepareTinyBvh({cacheRoot: root, manifest, fetchImpl}))
      .rejects.toThrow('SHA-256 mismatch: tiny_bvh.h');
    expect(await readdir(join(root, manifest.revision))).toEqual([]);
  });

  it('reports failed downloads and resumes from verified files on retry', async () => {
    const root = await cacheRoot();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(contents))
      .mockResolvedValueOnce(new Response('', {status: 503}));
    await expect(prepareTinyBvh({cacheRoot: root, manifest, fetchImpl}))
      .rejects.toThrow('tiny_bvh_base.h (HTTP 503)');
    expect(await readdir(join(root, manifest.revision))).toEqual(['tiny_bvh.h']);
    fetchImpl.mockReset().mockImplementation(async () => new Response(contents));
    await prepareTinyBvh({cacheRoot: root, manifest, fetchImpl});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('allows concurrent preparations to publish only complete verified files', async () => {
    const root = await cacheRoot();
    const options = {cacheRoot: root, manifest, fetchImpl: async () => new Response(contents)};
    const directories = await Promise.all(Array.from({length: 16}, () => prepareTinyBvh(options)));
    const first = directories[0];
    expect(directories.every(directory => directory === first)).toBe(true);
    for (const {file} of manifest.files) expect(await readFile(join(first, file))).toEqual(contents);
    expect(await readdir(first)).toEqual(manifest.files.map(({file}) => file));
  });
});
