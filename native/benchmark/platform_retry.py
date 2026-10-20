"""Validation-only reruns for positively identified Metal sample faults.

An image difference alone is never evidence. Keep each attempt in its own
folder so an eventual pass cannot overwrite the first failure.
"""
import json
from pathlib import Path

MAX_RERUNS = 3


def sample_evidence(*audits):
    """Inspect independent per-pixel execution/normal counts, then paired hits.

    Each list comes from image-diagnostics --audit-samples in the same attempt.
    Invalid/contradictory counters take priority over any positive evidence.
    """
    if not audits or any(not rows for rows in audits):
        raise ValueError('missing per-sample evidence')
    for rows in audits:
        for index, row in enumerate(rows):
            if (row['sample'] != index or row['pixels'] <= 0
                    or row['invalidPixels'] != 0
                    or not 0 <= row['shortPixels'] <= row['pixels']
                    or not 0 <= row['interiorHits'] <= row['primaryHits'] <= row['pixels']):
                raise ValueError('invalid or contradictory sample counters')
    for side, rows in enumerate(audits):
        for row in rows:
            if row['shortPixels']:
                return {'kind': 'sample-count-short', 'sample': row['sample'],
                        'side': side, 'shortPixels': row['shortPixels'],
                        'pixels': row['pixels'], 'independentCountersAgree': True}
    if len(audits) == 2:
        if len(audits[0]) != len(audits[1]):
            raise ValueError('unexplained audit length difference')
        for a, b in zip(*audits):
            if a['pixels'] != b['pixels']:
                raise ValueError('paired image size mismatch')
            if ((a['primaryHits'] == 0 and b['interiorHits'] > 0)
                    or (b['primaryHits'] == 0 and a['interiorHits'] > 0)):
                return {'kind': 'all-primary-hits-lost', 'sample': a['sample'],
                        'primaryHits': [a['primaryHits'], b['primaryHits']],
                        'interiorHits': [a['interiorHits'], b['interiorHits']],
                        'sameAttempt': True}
    return None


def positive(e):
    if not isinstance(e, dict) or not isinstance(e.get('sample'), int) or e['sample'] < 0:
        return False
    if e.get('kind') == 'sample-count-short':
        return (e.get('independentCountersAgree') is True
                and isinstance(e.get('shortPixels'), int)
                and isinstance(e.get('pixels'), int)
                and 0 < e['shortPixels'] <= e['pixels'])
    if e.get('kind') == 'all-primary-hits-lost':
        hits, interior = e.get('primaryHits', []), e.get('interiorHits', [])
        return (e.get('sameAttempt') is True and len(hits) == len(interior) == 2
                and all(isinstance(v, int) and v >= 0 for v in hits + interior)
                and all(i <= h for i, h in zip(interior, hits))
                and ((hits[0] == 0 and interior[1] > 0)
                     or (hits[1] == 0 and interior[0] > 0)))
    return False


def run_with_retry(test, root, operation):
    """operation(folder) returns passed, step, evidence (optional), details.

    Contradictory evidence or a simultaneous unknown failure must be returned as
    classification='unknown', even when a separate sample also has a fault.
    """
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    for attempt in range(MAX_RERUNS + 1):
        folder = root / f'attempt-{attempt}'
        folder.mkdir()  # Never reuse output from a previous invocation.
        result = operation(folder)
        (folder / 'result.json').write_text(json.dumps(result, indent=2))
        if result['passed']:
            return result | {'reruns': attempt, 'attemptDirectory': str(folder)}
        evidence = result.get('evidence')
        identified = result.get('classification') == 'a' and positive(evidence)
        event = {'test': test, 'attempt': attempt, 'step': result.get('step'),
                 'sample': (evidence or {}).get('sample'), 'evidence': evidence,
                 'classification': 'a' if identified else result.get('classification', 'unknown'),
                 'rerun': identified and attempt < MAX_RERUNS,
                 'capture': str(folder)}
        print(json.dumps(event), flush=True)
        with (root / 'events.jsonl').open('a') as output:
            output.write(json.dumps(event) + '\n')
        if not event['rerun']:
            raise RuntimeError(f'{test}: failed without permitted rerun: {folder}')
    raise AssertionError('unreachable')
