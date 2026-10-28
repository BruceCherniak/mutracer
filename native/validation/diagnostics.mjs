// Coverage can report success while exported, uncalled functions still have
// errors. A library gate must count those errors too.
export function summarizeCoverage(report, exitCode) {
  if (report?.schema !== 'scriptc-diagnostics' || report.schemaVersion !== 1
    || !Array.isArray(report.groups)) {
    throw new Error('Unrecognized scriptc diagnostics; refusing to report success.');
  }
  const errors = report.groups.filter(group => group.severity === 'error');
  const byCode = {};
  for (const group of errors) {
    const count = group.count;
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid diagnostic count.');
    byCode[group.code] = (byCode[group.code] ?? 0) + count;
  }
  return {
    passed: exitCode === 0 && report.success === true && errors.length === 0,
    phase: report.phase,
    errorGroups: errors.length,
    errorSites: errors.reduce((sum, group) => sum + group.count, 0),
    unreachedErrorGroups: errors.filter(group => group.scope === 'unreached').length,
    byCode,
    stats: report.stats
  };
}
