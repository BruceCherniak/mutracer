export function comparison(results: {
  backend: string; version: string; activeFrameCPUms: number; liveHeapBytes: number;
}[]): {
  backend: string;
  ratios: {activeFrameCPUms: number; liveHeapBytes: number};
  activeFrameCPUmsDelta: number;
  regression: boolean;
}[];
