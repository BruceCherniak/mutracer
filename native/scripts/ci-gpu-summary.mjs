// Combine all completed GPU checks without changing their failure policies.
export function gpuValidationCoverage(oracle, hostGpuTests, cHosts) {
 const reasons = [
  oracle.skipped && `${oracle.skipped} full-reference renders failed`,
  hostGpuTests.knownOpenHwrtFailures && `${hostGpuTests.knownOpenHwrtFailures} known-open Metal HWRT image mismatches`,
 ].filter(Boolean);
 let hosts;
 if (cHosts !== undefined) {
  if (cHosts?.complete !== true || !Array.isArray(cHosts.results) || !cHosts.results.length ||
      cHosts.results.some(result => !Number.isSafeInteger(result?.hardwareDifferences) || result.hardwareDifferences < 0))
   throw Error('Incomplete or invalid C host engine verification results.');
  const hardwareDifferences = cHosts.results.reduce((sum, result) => sum + result.hardwareDifferences, 0);
  if (!Number.isSafeInteger(hardwareDifferences))
   throw Error('Invalid C host hardware difference total.');
  hosts = {cases: cHosts.results.length, hardwareDifferences};
  if (hardwareDifferences) reasons.push(`${hardwareDifferences} C host HWRT image mismatches`);
 }
 return {
  validated: reasons.length === 0,
  ...(hosts && {cHosts: hosts}),
  ...(reasons.length && {reason: reasons.join('; ') + '; review failures before release'}),
 };
}
