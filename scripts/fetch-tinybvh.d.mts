export interface TinyBvhManifest {
  revision: string;
  version: string;
  files: {file: string; sha256: string}[];
}

export const tinyBvhManifest: TinyBvhManifest;
export function prepareTinyBvh(options?: {
  cacheRoot?: string;
  manifest?: TinyBvhManifest;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<string>;
