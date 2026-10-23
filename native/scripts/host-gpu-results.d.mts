export function hwrtLoopIterations(value?: string): number;
export function classifyHostGpuResult(
 test: string,
 result: {status: number | null; output?: string; error?: Error; signal?: string | null},
 gpu: {hardware?: boolean; backend?: string},
): {status: 'passed' | 'known-open-hwrt-failure' | 'failed'; failure?: string};
