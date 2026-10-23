import { SkyBaker } from './sky';
import type { SkyBakeResponse } from './skyWorker';

const scope = self as unknown as {
  onmessage: (event: MessageEvent<number>) => void;
  postMessage: (message: SkyBakeResponse, transfer?: Transferable[]) => void;
};
let baker: SkyBaker | undefined;
scope.onmessage = ({ data: hours }) => {
  try {
    baker ??= new SkyBaker();
    const data = baker.bake(hours);
    scope.postMessage({ data }, [data.data.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
