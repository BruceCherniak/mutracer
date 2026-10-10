/** Best-effort storage of original HDR bytes in the viewer's private filesystem. */
export async function openHDRCache(url: string) {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const absolute = new URL(url, globalThis.location?.href);
    absolute.hash = '';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(absolute.href));
    const name = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') + '.hdr';
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('mutracer-hdr-v1', { create: true });
    return {
      async read(): Promise<ArrayBuffer | null> {
        try {
          const handle = await directory.getFileHandle(name);
          return await (await handle.getFile()).arrayBuffer();
        } catch {
          return null;
        }
      },
      async write(buffer: ArrayBuffer): Promise<void> {
        let writable: FileSystemWritableFileStream | undefined;
        try {
          const handle = await directory.getFileHandle(name, { create: true });
          writable = await handle.createWritable();
          await writable.write(buffer);
          await writable.close();
        } catch {
          // A denied/quota-limited cache must never prevent loading the environment.
          await writable?.abort().catch(() => {});
        }
      },
      async remove(): Promise<void> {
        try {
          await directory.removeEntry(name);
        } catch {
          // The browser may already have evicted it, or storage may be unavailable.
        }
      }
    };
  } catch {
    return null;
  }
}
