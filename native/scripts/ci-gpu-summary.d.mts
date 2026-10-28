export function gpuValidationCoverage(
 oracle: {passed?: number; skipped: number},
 hostGpuTests: {knownOpenHwrtFailures: number},
 cHosts?: unknown,
): {
 validated: boolean;
 cHosts?: {cases: number; hardwareDifferences: number};
 reason?: string;
};
