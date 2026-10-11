import { executeBvhBuild } from './bvhWorkerBuild.js';
import type { BvhBuildRequest, BvhBuildResponse } from './bvhWorkerClient.js';

const scope = self as unknown as {
  onmessage: (event: MessageEvent<BvhBuildRequest>) => void;
  postMessage: (response: BvhBuildResponse, transfers?: Transferable[]) => void;
};
// Serialize builds to reuse TinyBVH's WASM instance and bound working memory.
let queue = Promise.resolve();
scope.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const bvh = await executeBvhBuild(data);
      scope.postMessage({ id: data.id, bvh }, [bvh.buffer]);
    } catch (error) {
      scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
};
