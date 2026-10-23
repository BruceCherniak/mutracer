import { createSkyAt } from './sky';

self.onmessage = (event: MessageEvent<number>) => {
  const sky = createSkyAt(event.data);
  self.postMessage(sky, { transfer: [sky.data.buffer] });
};
