import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reference, buildLibrary, serve, ready, root} from './reference-capture.mjs';
import {launchChrome, delay} from './reference-runtime.mjs';

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
export function comparison(results) {
  return ['webgpu', 'webgl'].map(backend => {
    const values = version => results.filter(row => row.backend === backend && row.version === version);
    const means = version => Object.fromEntries(['activeFrameCPUms', 'liveHeapBytes'].map(metric =>
      [metric, mean(values(version).map(row => row[metric]))]));
    const reference = means('reference'), current = means('current');
    const ratios = Object.fromEntries(Object.keys(reference).map(metric => [metric, current[metric] / reference[metric]]));
    const activeFrameCPUmsDelta = current.activeFrameCPUms - reference.activeFrameCPUms;
    return {backend, ratios, activeFrameCPUmsDelta,
      regression: (ratios.activeFrameCPUms > 1.03 && activeFrameCPUmsDelta > 0.05) || ratios.liveHeapBytes > 1.03};
  });
}

async function main() {
  const args = process.argv.slice(2), index = args.indexOf('--rounds');
  const rounds = index < 0 ? 1 : Number(args[index + 1]);
  const commit = args.find((value, i) => (index < 0 || i !== index && i !== index + 1) && !value.startsWith('--')) ?? '516f3df8';
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw Error('--rounds must be a positive integer');
  const base = reference(commit);
  const output = resolve(process.env.MUTRACER_PERFORMANCE_OUTPUT ?? resolve(base.directory, 'performance'));
  mkdirSync(output, {recursive: true});
  buildLibrary(base.source, base.directory);
  buildLibrary(root, output);
  const servers = [];
  let chrome;
  const results = [];

  try {
    for (const source of [base.source, root]) servers.push(await serve(source, output,
      resolve(root, 'scripts/reference-performance-browser.ts')));
    chrome = await launchChrome();
    let total = rounds;
    for (let round = 1; round <= total; round++) {
      for (const backend of ['webgpu', 'webgl']) for (const version of ['reference', 'current']) {
        const server = servers[version === 'reference' ? 0 : 1];
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
          const page = await chrome.page(server.url + (backend === 'webgl' ? '?webgl' : ''));
          try {
            await ready(page.tab);
            await page.tab.evaluate(`void window.runBenchmark().catch(e => window.benchmarkError = String(e.stack ?? e))`);
            for (let i = 0; i < 2400; i++) {
              const state = await page.tab.evaluate('({result: window.benchmarkResult, error: window.benchmarkError})');
              if (state.error) throw Error(state.error);
              if (state.result) {result = state.result; break;}
              await delay(100);
            }
            if (!result) throw Error('Performance timeout');
            await page.tab.call('HeapProfiler.enable');
            for (let i = 0; i < 3; i++) {
              await page.tab.evaluate('gc()');
              await page.tab.call('HeapProfiler.collectGarbage');
            }
            result.liveHeapBytes = (await page.tab.call('Runtime.getHeapUsage')).usedSize;
            await page.tab.evaluate('window.finishBenchmark()');
            results.push({...result, round, version, forcedGC: true});
            console.log(round, backend, version, result);
            break;
          } catch (error) {
            if (!error.message.includes('Foreground') || attempt === 2) throw error;
            result = undefined;
          } finally {await page.close();}
        }
      }
      if (comparison(results).some(row => row.regression)) total = Math.max(total, 3);
      writeFileSync(resolve(output, 'performance.json'), JSON.stringify({reference: base.sha, requestedRounds: rounds,
        actualRounds: round, plannedRounds: total, comparison: comparison(results), results}, null, 2) + '\n');
    }
  } finally {await chrome?.close(); for (const server of servers) await server.close();}

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
