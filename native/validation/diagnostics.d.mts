export interface CoverageSummary {
  passed: boolean;
  phase: string;
  errorGroups: number;
  errorSites: number;
  unreachedErrorGroups: number;
  byCode: Record<string, number>;
  stats?: unknown;
}
export function summarizeCoverage(report: unknown, exitCode: number | null): CoverageSummary;
