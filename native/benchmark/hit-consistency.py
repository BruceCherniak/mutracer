"""Classify fixed-sample first-hit records emitted by hit-diagnostics (NumPy)."""
import argparse
import json
from pathlib import Path
import numpy as np

HIT = np.dtype([('hit', '<u4'), ('instance', '<i4'), ('record', '<i4'),
                ('t', '<f4'), ('bary', '<f4', (3,)), ('reserved', '<f4')])

class PackedGeometry:
    """Decode the explicit diagnostic snapshot; arithmetic is float64 throughout."""
    def __init__(self, directory):
        directory = Path(directory)
        layout = json.loads((directory / 'layout.json').read_text())
        self.stride = layout['attributeStrideBytes'] // 4
        self.position = layout['positionOffsetBytes'] // 4
        self.instances = np.fromfile(directory / 'native-2.bin', dtype='<u4').reshape(-1, 40) if not layout['isEmpty'] else np.zeros((0,40), dtype='<u4')
        self.bvh = np.fromfile(directory / 'native-1.bin', dtype='<u4').reshape(-1, 4)
        self.attributes = np.fromfile(directory / 'native-3.bin', dtype='<f4').reshape(-1, self.stride) if self.stride else np.zeros((0,0))
    def points(self, hits):
        result = np.full((len(hits),3), np.nan)
        valid = (hits['hit']!=0)&(hits['instance']>=0)&(hits['instance']<len(self.instances))&(hits['record']>=0)&(hits['record']<len(self.bvh))
        ids = np.flatnonzero(valid)
        for start in range(0,len(ids),65536):
            selected = ids[start:start+65536]
            ins = self.instances[hits['instance'][selected]]
            index = self.bvh[hits['record'][selected],:3].astype(np.int64) + ins[:,1,None]
            triangle = self.attributes[index,self.position:self.position+3].astype(float)
            matrix = ins[:,20:36].copy().view('<f4').reshape(-1,4,4).transpose(0,2,1).astype(float)
            world = np.einsum('nij,nkj->nki',matrix[:,:3,:3],triangle) + matrix[:,:3,3][:,None,:]
            result[selected] = np.einsum('nk,nkj->nj',hits['bary'][selected].astype(float),world)
        return result

def classify(sw, hw, world_distance):
    if sw.shape != hw.shape:
        raise ValueError('Hit record counts differ')
    a, b = sw['hit'] != 0, hw['hit'] != 0
    both = a & b
    identity = both & ((sw['instance'] != hw['instance']) | (sw['record'] != hw['record']))
    numeric = both & ((sw['t'] != hw['t']) | np.any(sw['bary'] != hw['bary'], axis=1))
    invalid = np.zeros(len(sw), dtype=bool)
    for hits, valid in [(sw, a), (hw, b)]:
        invalid |= valid & (~np.isfinite(hits['t']) | ~np.isfinite(hits['bary']).all(axis=1)
                           | (hits['t'] <= 0) | (hits['instance'] < 0) | (hits['record'] < 0))
    delta = np.abs(sw['t'].astype(float) - hw['t'].astype(float))
    relative = delta / np.maximum(1., sw['t'].astype(float))
    bary_delta = np.abs(sw['bary'].astype(float) - hw['bary'].astype(float))
    same = both & ~identity & ~invalid
    world_distance = np.asarray(world_distance, dtype=float)
    if world_distance.shape != (len(sw),):
        raise ValueError('World point distances do not match hit records')
    scaled_distance = world_distance / np.maximum(1., sw['t'].astype(float))
    consistent = (~a & ~b) | (same & (relative <= 1e-4) & np.isfinite(world_distance) & (scaled_distance <= 1e-4))
    # Edge/tie exceptions apply only to different hits, never to an
    # over-budget numerical error on the same instance + record.
    different = (a != b) | identity
    edge = different & ~invalid & ((a & (sw['bary'].min(axis=1) < 1e-3))
                                  | (b & (hw['bary'].min(axis=1) < 1e-3)))
    tie = identity & ~invalid & ~edge & (relative <= 1e-5)
    other = ~(consistent | edge | tie)
    mismatch = ~consistent
    def distribution(values):
        values = values[np.isfinite(values)]
        return {'count': len(values), 'max': float(values.max()) if len(values) else 0.,
                'p99': float(np.percentile(values, 99)) if len(values) else 0.,
                'p99.99': float(np.percentile(values, 99.99)) if len(values) else 0.,
                'p99.999': float(np.percentile(values, 99.999)) if len(values) else 0.,
                'histogramBounds': [0., 1e-8, 1e-7, 1e-6, 1e-5, 2.5e-5, 5e-5, 9e-5, 1e-4, 'infinity'],
                'histogramCounts': np.histogram(values, bins=[0., 1e-8, 1e-7, 1e-6, 1e-5, 2.5e-5, 5e-5, 9e-5, 1e-4, float('inf')])[0].tolist()}
    codes = np.zeros(len(sw), dtype=np.uint8)
    codes[edge], codes[tie], codes[other] = 1, 2, 3
    counts = {k: int(np.sum(v)) for k, v in [('agree', ~mismatch), ('edge', edge), ('tie', tie), ('other', other)]}
    total = len(sw)
    return codes, {'rays': total, 'counts': counts,
                   'fractionsOfAllRays': {k: v / total if total else 0 for k, v in counts.items()},
                   'mismatches': int(mismatch.sum()), 'identityMismatches': int(identity.sum()),
                   'hitMissMismatches': int(np.sum(a != b)),
                   'sameIdentityNumericDifferences': int(np.sum(numeric & same)),
                   'sameIdentityNumericalBudgetExceeded': int(np.sum(other & same)),
                   'sameIdentityErrors': {'relativeDeltaT': {**distribution(relative[same]), 'normalization': 'abs(deltaT)/max(1,tSW), used by the plan budget'},
                                          'trueRelativeDeltaT': distribution(delta[same] / sw['t'][same].astype(float)),
                                          'absoluteDeltaT': distribution(delta[same]),
                                          'worldPointDistance': distribution(world_distance[same]),
                                          'scaledWorldPointDistance': distribution(scaled_distance[same]),
                                          'barycentricComponentAbsDelta': [distribution(bary_delta[same, i]) for i in range(3)]},
                   'invalid': int(invalid.sum()), 'pass': counts['other'] == 0}

def analyze(directory, output=None, geometry=None):
    directory = Path(directory)
    info = json.loads((directory / 'info.json').read_text())
    sw, hw = [np.fromfile(directory / (name + '.hit.bin'), dtype=HIT) for name in ['software', 'hardware']]
    if len(sw) != info['width'] * info['height']:
        raise ValueError('Dimensions differ from record count')
    geometry = PackedGeometry(geometry or directory)
    world_distance = np.linalg.norm(geometry.points(sw)-geometry.points(hw),axis=1)
    codes, result = classify(sw, hw, world_distance)
    result.update({'width': info['width'], 'height': info['height'], 'actualBackend': info['actualBackend'],
                   'comparison': 'Same instance/record: relative t and world point distance/max(1,tSW) <=1e-4; barycentric errors are diagnostic only; differing hit: edge first (<1e-3), then distinct-triangle t tie (<=1e-5).',
                   'codes': {'0': 'agree', '1': 'edge', '2': 'tie', '3': 'other'}})
    output = Path(output) if output else directory
    output.mkdir(parents=True, exist_ok=True)
    codes.tofile(output / 'classification.u8')
    examples = []
    for i in np.flatnonzero(codes == 3)[:100]:
        def values(data):
            return {k: data[k].tolist() for k in ['hit', 'instance', 'record', 't', 'bary']}
        examples.append({'pixel': int(i), 'x': int(i % info['width']), 'yBottomFirst': int(i // info['width']),
                         'software': values(sw[i]), 'hardware': values(hw[i])})
    result['otherExamples'] = examples
    (output / 'classification.json').write_text(json.dumps(result, indent=2))
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--geometry', type=Path)
    args = parser.parse_args()
    result = analyze(args.directory, args.output, args.geometry)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['pass'] else 1)
