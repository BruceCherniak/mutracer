"""Behavioral contract: only positive faults rerun, at most three times."""
import json
from pathlib import Path
import tempfile
import unittest
from platform_retry import run_with_retry, sample_evidence


def row(**changes):
    return dict(sample=0, pixels=64, primaryHits=32, interiorHits=20,
                shortPixels=0, invalidPixels=0) | changes


class PlatformRetry(unittest.TestCase):
    def test_benign_empty_and_ordinary_differences_are_not_evidence(self):
        self.assertIsNone(sample_evidence([row()], [row(primaryHits=31)]))
        self.assertIsNone(sample_evidence([row(primaryHits=0, interiorHits=0)]))
        self.assertIsNone(sample_evidence(*[[row(primaryHits=0, interiorHits=0)]] * 2))
        self.assertIsNotNone(sample_evidence([row()], [row(primaryHits=0, interiorHits=0)]))
        self.assertIsNotNone(sample_evidence([row(shortPixels=2)]))
        with self.assertRaises(ValueError):
            sample_evidence([row(shortPixels=2)], [row(invalidPixels=1)])

    def run_attempts(self, classification, evidence, passes_at=None):
        with tempfile.TemporaryDirectory() as tmp:
            calls = []
            def operation(folder):
                calls.append(folder)
                (folder / 'first.bin').write_bytes(bytes([len(calls)]))
                return dict(passed=len(calls) == passes_at, classification=classification,
                            evidence=evidence, step='byte comparison')
            try:
                result = run_with_retry('fixture', tmp, operation)
            except RuntimeError:
                result = None
            events = [json.loads(s) for s in (Path(tmp) / 'events.jsonl').read_text().splitlines()]
            self.assertEqual((calls[0] / 'first.bin').read_bytes(), b'\x01')
            return result, calls, events

    def test_three_reruns_preserve_first_failure_and_exhaust(self):
        evidence = sample_evidence([row(shortPixels=64)])
        result, calls, events = self.run_attempts('a', evidence)
        self.assertIsNone(result)
        self.assertEqual(len(calls), 4)
        self.assertEqual([e['rerun'] for e in events], [True, True, True, False])
        result, calls, events = self.run_attempts('a', evidence, 3)
        self.assertEqual(result['reruns'], 2)
        self.assertEqual(len(events), 2)

    def test_other_unknown_or_unsubstantiated_fault_never_reruns(self):
        for classification in ['b', 'c', 'unknown', 'a']:
            result, calls, events = self.run_attempts(classification, None)
            self.assertIsNone(result)
            self.assertEqual(len(calls), 1)
            self.assertFalse(events[0]['rerun'])
        result, calls, events = self.run_attempts('unknown', sample_evidence([row(shortPixels=1)]))
        self.assertEqual(len(calls), 1)
