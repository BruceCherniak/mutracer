import type { ModelSource } from './loadModel';

export interface ModelMeta {
  name: string;
  presetId: string | null;
  credit: string | null;
  sourceUrl: string | null;
}

export interface CachedModel {
  id: string;
  meta: ModelMeta;
  /** Procedural presets have no files. */
  source?: ModelSource;
}

const DIRECTORY = 'mutracer-model-v1';
const CURRENT = 'current.model';
// One archive keeps replacement atomic and avoids retaining old dependencies.
// Serialize reads/writes within this viewer so an earlier write cannot win.
let pending: Promise<unknown> = Promise.resolve();
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = pending.then(run, run);
  pending = next.catch(() => {});
  return next;
}

async function directory() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  return (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY, { create: true });
}

/** Storage failures are optional; they never stop model loading. */
export function saveModelCache(model: CachedModel): Promise<void> {
  return enqueue(async () => {
    let dir: FileSystemDirectoryHandle | null = null;
    let writable: FileSystemWritableFileStream | undefined;
    try {
      dir = await directory();
      if (!dir) return;
      const source = model.source;
      const header = new TextEncoder().encode(JSON.stringify({
        version: 1, id: model.id, meta: model.meta,
        source: source && {
          mainPath: source.mainPath, base: source.base,
          files: source.files.map(({ file, path }) => ({ path, name: file.name, type: file.type, size: file.size, lastModified: file.lastModified }))
        }
      }));
      const length = new ArrayBuffer(4);
      new DataView(length).setUint32(0, header.byteLength, true);
      const handle = await dir.getFileHandle(CURRENT, { create: true });
      writable = await handle.createWritable();
      await writable.write(new Blob([length, header, ...(source?.files.map(({ file }) => file) ?? [])]));
      await writable.close();
    } catch {
      await writable?.abort().catch(() => {});
      // Never restore the previous model after a replacement failed to persist.
      await dir?.removeEntry(CURRENT).catch(() => {});
    }
  });
}

export function readModelCache(): Promise<CachedModel | null> {
  return enqueue(async () => {
    try {
      const dir = await directory();
      if (!dir) return null;
      const file = await (await dir.getFileHandle(CURRENT)).getFile();
      const length = new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0, true);
      if (length > 4 * 1024 * 1024 || length + 4 > file.size) return null;
      const header = JSON.parse(await file.slice(4, 4 + length).text());
      if (header.version !== 1 || typeof header.id !== 'string' || typeof header.meta?.name !== 'string') return null;
      for (const key of ['presetId', 'credit', 'sourceUrl']) {
        if (header.meta[key] !== null && typeof header.meta[key] !== 'string') return null;
      }
      let source: ModelSource | undefined;
      let offset = 4 + length;
      if (header.source) {
        const data = header.source;
        if (typeof data.mainPath !== 'string' || typeof data.base !== 'string' || !Array.isArray(data.files)) return null;
        source = { mainPath: data.mainPath, base: data.base, files: [] };
        for (const entry of data.files) {
          if (typeof entry.path !== 'string' || typeof entry.name !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0 || offset + entry.size > file.size) return null;
          source.files.push({
            path: entry.path,
            file: new File([file.slice(offset, offset + entry.size)], entry.name, { type: entry.type, lastModified: entry.lastModified })
          });
          offset += entry.size;
        }
        if (!source.files.some(({ path }) => path === source!.mainPath)) return null;
      } else if (!header.meta.presetId) return null;
      if (offset !== file.size) return null;
      return { id: header.id, meta: header.meta, source };
    } catch {
      return null;
    }
  });
}

export function clearModelCache(): Promise<void> {
  return enqueue(async () => {
    try { await (await directory())?.removeEntry(CURRENT); } catch { /* Best effort. */ }
  });
}
