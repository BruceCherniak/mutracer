"""Rerun native-perf correctness, preserving every classified attempt.

Reference arguments point to frozen evidence, never to output directories of
this invocation. No image mismatch is used as a reason to rerun by itself.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import numpy as np
from platform_retry import run_with_retry, sample_evidence

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
KINDS = ['hdr', 'normal', 'albedo']


def load(path):
    return json.loads(Path(path).read_text())


def run(folder, name, command, allowed=False):
    with (folder / (name + '.log')).open('w') as output:
        proc = subprocess.run(list(map(str, command)), cwd=ROOT,
                              env=os.environ | {'MUTRACER_NATIVE_DIRECT_AS': '1'},
                              stdout=output, stderr=subprocess.STDOUT)
    if proc.returncode and not allowed:
        raise RuntimeError(f'command failure (not retryable): {folder}/{name}.log')


def observed(args, source, folder, backend, samples):
    run(folder.parent, folder.name, [args.artifacts / 'image-diagnostics', source,
                                   folder, backend, samples, 12345, '--audit-samples'])
    if load(folder / 'info.json')['actualBackend'] != backend:
        raise ValueError('unexpected backend')
    return load(folder / 'sample-audit.json')


def fault(evidence, step):
    return dict(passed=False, classification='a', evidence=evidence, step=step)


def statistics(args):
    p = args.phase2
    base = load(p / 'v4-phase1-inputs.json')
    extras = [c for c in load(p / 'v4-inputs.json') if c['key'] not in {x['key'] for x in base}]
    cases = base + extras
    rows = []
    for c in cases:
        key, coll = c['key'], c.get('collection', 'extra')
        reference = p / 'reference-67890' / coll / key if coll != 'extra' else args.extra_references / key
        def operation(folder):
            audits = [observed(args, c['input'], folder / str(b), b, 64) for b in [0, 1]]
            evidence = sample_evidence(*audits)
            if evidence:
                return fault(evidence, '64spp image comparison')
            fidelity = [load(folder/str(b)/'same-as-fidelity.json') for b in [0,1]]
            if not all(all(v.values()) for v in fidelity):
                return dict(passed=False, classification='unknown', step='same-AS sample instrumentation fidelity', details=fidelity)
            row = dict(key=key, collection=coll, statistics={}, softwareBytes={}, sameAsFidelity=fidelity)
            for kind in KINDS:
                paths = [folder / '0' / (kind+'.bin'), folder / '1' / (kind+'.bin'), reference / (kind+'.bin')]
                a, b, ref = [np.fromfile(f, dtype='<f4').reshape(-1, 4) for f in paths]
                finite = all(np.isfinite(x).all() for x in [a, b, ref])
                ae, be = [float(np.sqrt(np.mean((x[:, :3].astype(float)-ref[:, :3])**2))) for x in [a, b]]
                ratio = be/ae if ae else 1 if be == 0 else None
                row['statistics'][kind] = dict(ratio=ratio, finite=bool(finite), passGate=bool(finite and ratio is not None and ratio <= 1.05))
                row['softwareBytes'][kind] = paths[0].read_bytes() == (p/'stage-final/as-gate/images'/key/'0'/(kind+'.bin')).read_bytes()
            return dict(passed=all(row['softwareBytes'].values()) and all(v['finite'] for v in row['statistics'].values()), classification='unknown', step='software bytes/finite', details=row)
        result = run_with_retry('statistics/'+key, args.output/'images'/key, operation)
        row = result['details'] | {'reruns': result['reruns'], 'attemptDirectory': result['attemptDirectory']}
        if not (key.startswith('v3-displacement') and key != 'v3-displacement-zero'):
            def hit_operation(folder):
                dest = folder/'hits'
                run(folder, 'render', [args.artifacts/'hit-diagnostics', c['input'], dest])
                run(folder, 'classify', [sys.executable, HERE/'hit-consistency.py', dest], True)
                classification = load(dest/'classification.json')
                spec = importlib.util.spec_from_file_location('hit_consistency', HERE/'hit-consistency.py')
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                pair = [np.fromfile(dest/(side+'.hit.bin'), dtype=module.HIT) for side in ['software', 'hardware']]
                hits = [int(np.count_nonzero(h['hit'])) for h in pair]
                interior = [int(np.count_nonzero((h['hit'] != 0) & (np.min(h['bary'], axis=1) > .001))) for h in pair]
                evidence = None
                valid = len(pair[0]) == len(pair[1]) and len(pair[0]) > 0 and all(np.isfinite(h['t']).all() and np.isfinite(h['bary']).all() and np.isin(h['hit'], [0, 1]).all() for h in pair)
                if valid and ((hits[0] == 0 and interior[1] > 0) or (hits[1] == 0 and interior[0] > 0)):
                    evidence = dict(kind='all-primary-hits-lost', sample=0, primaryHits=hits, interiorHits=interior, sameAttempt=True)
                if evidence:
                    return fault(evidence, 'first-hit records')
                return dict(passed=classification['counts'].get('other', 0) == 0, classification='unknown', step='first-hit classification', details=classification)
            hit = run_with_retry('hits/'+key, args.output/'hits'/key, hit_operation)
            row['hits'], row['hitReruns'] = hit['details'], hit['reruns']
        rows.append(row)
        (args.output/'statistics.json').write_text(json.dumps(rows, indent=2))
        print(key, {k: v['ratio'] for k, v in row['statistics'].items()}, flush=True)
    for row in rows:
        if all(v['passGate'] for v in row['statistics'].values()):
            continue
        c = next(c for c in cases if c['key'] == row['key'])
        folder = args.output/'paths'/row['key']; folder.mkdir(parents=True)
        for backend, side in [(0, 'software'), (1, 'hardware')]:
            run(folder, side, [args.artifacts/'path-diagnostics', c['input'], folder/side, backend])
            fidelity = load(folder/side/'same-as-fidelity.json')
            row[side+'PathBytes'] = fidelity
        run(folder, 'classify', [sys.executable, HERE/'path-consistency.py', folder], True)
        row['path'] = load(folder/'classification.json')
        (args.output/'statistics.json').write_text(json.dumps(rows, indent=2))
        # A path/fidelity mismatch has no positive sample-fault evidence here:
        # keep the original threshold and fail directly, without a rerun.
        if row['path']['firstDifferenceCounts'].get('other', 0) or row['path']['unpairedAfterConsistentPrefix'] or not all(row[s+'PathBytes'][k] for s in ['software','hardware'] for k in KINDS):
            raise RuntimeError(f'path gate failed without permitted rerun: {folder}')
    (args.output/'complete.json').write_text(json.dumps(dict(complete=True, groups=len(rows), hits=sum('hits' in r for r in rows), paths=sum('path' in r for r in rows), reruns=sum(r['reruns']+r.get('hitReruns',0) for r in rows)), indent=2))


def software(args):
    source = args.fixtures
    rows = []
    for c in load(source/'scene-verification.json')['results']:
        name = 'image' if c['variant'] == 'baseline' else c['variant']
        reference, data = args.software_reference/name, source/name/'scene-input.bin'
        if data.read_bytes() != (reference/'scene-input.bin').read_bytes():
            raise ValueError('different software fixture input')
        samples = load(reference/'result.json')['samples']
        def operation(folder):
            audit = observed(args, data, folder/'software', 0, samples)
            evidence = sample_evidence(audit)
            if evidence:
                return fault(evidence, 'software fixed-reference bytes')
            fidelity = load(folder/'software'/'same-as-fidelity.json')
            if not all(fidelity.values()):
                return dict(passed=False, classification='unknown', step='software same-AS audit fidelity', details=fidelity)
            matches = {k: (folder/'software'/(k+'.bin')).read_bytes() == (reference/(('render' if k=='hdr' else k)+'.rgba32f')).read_bytes() for k in KINDS}
            return dict(passed=all(matches.values()), classification='unknown', step='software byte comparison', details=dict(variant=c['variant'], samples=samples, matches=matches))
        result = run_with_retry('software/'+name, args.output/name, operation)
        rows.append(result['details'] | {'reruns': result['reruns']})
        (args.output/'summary.json').write_text(json.dumps(dict(complete=False, results=rows), indent=2))
        print(name, result['details']['matches'], flush=True)
    (args.output/'summary.json').write_text(json.dumps(dict(complete=True, passed=True, fixtures=len(rows), aovs=3*len(rows), reruns=sum(r['reruns'] for r in rows), results=rows), indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['statistics','software'])
    for arg in ['artifacts','output','phase2','extra-references','fixtures','software-reference']:
        parser.add_argument('--'+arg, type=Path, required=arg in ['artifacts','output'])
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.mode == 'statistics':
        statistics(args)
    else:
        software(args)
